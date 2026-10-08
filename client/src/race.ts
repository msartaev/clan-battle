import { Mesh, Scene, Vector3, type AbstractMesh } from "@babylonjs/core";
import { buildCarMesh, type CarKind } from "./cars";
import type { Effects, Sfx } from "./effects";
import { clamp } from "./utils";
import type { Track } from "./world";

/**
 * Уровень 5 — гонки с перестрелкой (идея Даниэля): 10 кругов по огромной трассе,
 * старт из пещеры, соперники на машинах стреляют. Победа — первым пройти 10 кругов
 * или выбить всех соперников.
 */

export const RACE_LAPS = 10;
/** Максимальная скорость машины в гонке, м/с */
export const RACE_TOP_SPEED = 19;
/** Вне асфальта машина вязнет */
export const RACE_OFFROAD_SPEED = 8;
const COUNTDOWN = 3;

export interface Racer {
  name: string;
  isPlayer: boolean;
  /** Машина соперника (у игрока своя — та, что в мире) */
  mesh: Mesh | null;
  yaw: number;
  speed: number;
  hp: number;
  lives: number;
  /** Пройдено кругов */
  lap: number;
  /** Следующая контрольная точка (номер в track.cps) */
  cp: number;
  /** Ближайшая точка осевой */
  idx: number;
  deadUntil: number;
  out: boolean;
  nextShotAt: number;
  frozenUntil: number;
  /** 0.8…0.95 — насколько быстро едет бот */
  skill: number;
  /** Свой ряд на трассе, чтобы боты не ехали гуськом */
  lane: number;
  laneUntil: number;
}

export interface RaceHost {
  scene: Scene;
  effects: Effects;
  sfx: Sfx;
  now(): number;
  /** Позиция и курс машины игрока */
  playerCar(): { pos: Vector3; yaw: number; alive: boolean };
  damagePlayer(dmg: number): void;
  message(text: string, sec: number, color: string): void;
  /** Видно ли из точки в точку (нет стен) */
  clearLine(from: Vector3, to: Vector3): boolean;
}

const BOTS: { name: string; color: string; kind: CarKind }[] = [
  { name: "Синий", color: "#2a62d6", kind: "sedan" },
  { name: "Зелёный", color: "#2f9a3a", kind: "pickup" },
  { name: "Жёлтый", color: "#e0b31c", kind: "suv" },
];

export class Race {
  readonly racers: Racer[] = [];
  readonly player: Racer;
  startAt = 0;
  finished: Racer | null = null;

  constructor(private host: RaceHost, readonly track: Track) {
    this.player = this.makeRacer("Ты", true, null);
    this.racers.push(this.player);
    BOTS.forEach((b, i) => {
      const mesh = buildCarMesh(host.scene, `racer${i}`, b.kind, b.color);
      mesh.checkCollisions = true;
      mesh.isPickable = true;
      mesh.ellipsoid = new Vector3(1.3, 0.75, 1.3);
      mesh.ellipsoidOffset = new Vector3(0, 0.75, 0);
      const r = this.makeRacer(b.name, false, mesh);
      r.skill = [0.93, 0.87, 0.82][i];
      r.lane = [3, -3, 3][i];
      mesh.metadata = { kind: "world", racer: r };
      for (const c of mesh.getChildMeshes()) {
        c.isPickable = true;
        c.metadata = { kind: "world", racer: r };
      }
      this.racers.push(r);
    });
  }

  private makeRacer(name: string, isPlayer: boolean, mesh: Mesh | null): Racer {
    return { name, isPlayer, mesh, yaw: 0, speed: 0, hp: 100, lives: 3, lap: 0, cp: 1, idx: 0, deadUntil: 0, out: false, nextShotAt: 0, frozenUntil: 0, skill: 1, lane: 0, laneUntil: 0 };
  }

  /** Все на старт: машины в пещере, отсчёт 3-2-1 */
  reset(): void {
    const g = this.track.grid;
    this.finished = null;
    this.startAt = this.host.now() + COUNTDOWN;
    this.racers.forEach((r, i) => {
      r.hp = 100;
      r.lives = 3;
      r.lap = 0;
      r.cp = 1;
      r.speed = 0;
      r.out = false;
      r.deadUntil = 0;
      r.frozenUntil = 0;
      r.nextShotAt = this.startAt + 2 + Math.random() * 2;
      r.yaw = g[i].yaw;
      r.idx = this.nearestIdx(g[i].pos, -1);
      if (r.mesh) {
        r.mesh.setEnabled(true);
        r.mesh.position.copyFrom(g[i].pos);
        r.mesh.rotation.set(0, r.yaw - Math.PI / 2, 0);
      }
    });
  }

  get started(): boolean {
    return this.host.now() >= this.startAt;
  }

  countdownText(): string | null {
    const left = this.startAt - this.host.now();
    if (left > 0) return String(Math.ceil(left));
    if (left > -1) return "Марш!";
    return null;
  }

  /** Ближайшая точка осевой (около подсказки — быстро, иначе по всей трассе) */
  nearestIdx(pos: Vector3, hint: number): number {
    const pts = this.track.pts;
    const N = pts.length;
    let best = 0;
    let bd = Infinity;
    const scan = (i: number) => {
      const p = pts[(i + N) % N];
      const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d < bd) {
        bd = d;
        best = (i + N) % N;
      }
    };
    if (hint >= 0) for (let k = -25; k <= 40; k++) scan(hint + k);
    if (hint < 0 || bd > 30 * 30) for (let i = 0; i < N; i++) scan(i);
    return best;
  }

  /** Расстояние от осевой: дальше половины ширины — уже не асфальт */
  offRoad(pos: Vector3, idx: number): boolean {
    const p = this.track.pts[idx];
    return Math.hypot(p.x - pos.x, p.z - pos.z) > this.track.width / 2 + 1;
  }

  /** Сколько пройдено: круги + контрольные точки + доля до следующей */
  progress(r: Racer): number {
    const cps = this.track.cps;
    const N = this.track.pts.length;
    const prevCp = cps[(r.cp - 1 + cps.length) % cps.length];
    const nextCp = cps[r.cp % cps.length];
    const span = (nextCp - prevCp + N) % N || N;
    let done = (r.idx - prevCp + N) % N;
    // Ещё не доехал до прошлой отметки (например, стоит в пещере до линии старта) — чуть «минус»
    if (done > span) done -= N;
    const frac = clamp(done / span, -1, 0.999);
    return r.lap * cps.length + ((r.cp - 1 + cps.length) % cps.length) + frac;
  }

  place(r: Racer): number {
    const live = this.racers.filter((x) => !x.out || x === r);
    const me = this.progress(r);
    return 1 + live.filter((x) => x !== r && this.progress(x) > me).length;
  }

  /** Отметить пройденные контрольные точки; true — машина только что закончила гонку */
  private checkpoints(r: Racer, pos: Vector3): boolean {
    r.idx = this.nearestIdx(pos, r.idx);
    const cps = this.track.cps;
    const target = this.track.pts[cps[r.cp % cps.length]];
    if ((target.x - pos.x) ** 2 + (target.z - pos.z) ** 2 < 16 * 16) {
      if (r.cp % cps.length === 0) {
        r.lap++;
        if (r.isPlayer && r.lap < RACE_LAPS) this.host.message(`Круг ${r.lap + 1} из ${RACE_LAPS}!`, 1.6, "#ffe14a");
        if (r.lap >= RACE_LAPS) return true;
      }
      r.cp = (r.cp % cps.length) + 1;
    }
    return false;
  }

  /** Куда вернуть выбывшую на время машину — к последней пройденной контрольной точке */
  respawnPoint(r: Racer): { pos: Vector3; yaw: number; idx: number } {
    const cps = this.track.cps;
    const idx = cps[(r.cp - 1 + cps.length) % cps.length];
    const t = this.track.tan[idx];
    const right = new Vector3(t.z, 0, -t.x);
    return { pos: this.track.pts[idx].add(right.scale(r.lane)), yaw: Math.atan2(t.x, t.z), idx };
  }

  /** Попадание по машине соперника */
  damage(r: Racer, dmg: number): boolean {
    if (r.out || r.deadUntil > this.host.now() || r.isPlayer) return false;
    r.hp -= dmg;
    if (r.hp > 0) return false;
    this.wreck(r);
    return true;
  }

  private wreck(r: Racer): void {
    const at = r.mesh!.position.add(new Vector3(0, 1, 0));
    this.host.effects.explosion(at, 2.5);
    this.host.sfx.boom(0.7);
    r.lives--;
    r.mesh!.setEnabled(false);
    r.speed = 0;
    if (r.lives <= 0) {
      r.out = true;
      this.host.message(`${r.name} выбыл из гонки!`, 2, "#ffe14a");
    } else {
      r.deadUntil = this.host.now() + 4;
      this.host.message(`${r.name} разбит! Осталось жизней: ${r.lives}`, 1.6, "#ffe14a");
    }
  }

  blast(at: Vector3, radius: number, dmgAt: (d: number) => number): number {
    let n = 0;
    for (const r of this.racers) {
      if (!r.mesh || r.out || !r.mesh.isEnabled()) continue;
      const d = Vector3.Distance(at, r.mesh.position);
      if (d > radius + 1) continue;
      if (this.damage(r, dmgAt(d))) n++;
    }
    return n;
  }

  freeze(at: Vector3, radius: number, until: number): number {
    let n = 0;
    for (const r of this.racers) {
      if (!r.mesh || r.out || !r.mesh.isEnabled()) continue;
      if (Vector3.Distance(at, r.mesh.position) > radius + 1) continue;
      r.frozenUntil = until;
      r.speed = 0;
      n++;
    }
    return n;
  }

  /** Игрок: отметки кругов. Возвращает true, если он финишировал */
  updatePlayer(pos: Vector3): boolean {
    if (!this.started || this.finished) return false;
    const done = this.checkpoints(this.player, pos);
    if (done) this.finished = this.player;
    return done;
  }

  /** Боты: едут по трассе, иногда стреляют. Возвращает финишировавшего бота */
  updateBots(dt: number): Racer | null {
    const now = this.host.now();
    const pts = this.track.pts;
    const tan = this.track.tan;
    const N = pts.length;
    const go = this.started;
    const pc = this.host.playerCar();
    for (const r of this.racers) {
      if (r.isPlayer || r.out) continue;
      const mesh = r.mesh!;
      if (!mesh.isEnabled()) {
        if (r.deadUntil > 0 && now >= r.deadUntil) {
          const sp = this.respawnPoint(r);
          mesh.position.copyFrom(sp.pos);
          r.yaw = sp.yaw;
          r.idx = sp.idx;
          r.hp = 100;
          r.deadUntil = 0;
          mesh.setEnabled(true);
        }
        continue;
      }
      if (!go || now < r.frozenUntil) {
        mesh.rotation.y = r.yaw - Math.PI / 2;
        continue;
      }
      // Впереди медленная машина — перестраиваемся в другой ряд
      const fwd0 = new Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      for (const o of this.racers) {
        if (o === r || o.out) continue;
        const op = o.isPlayer ? pc.pos : o.mesh!.isEnabled() ? o.mesh!.position : null;
        if (!op) continue;
        const to = op.subtract(mesh.position);
        const d = Math.hypot(to.x, to.z);
        if (d > 1 && d < 9 && (to.x * fwd0.x + to.z * fwd0.z) / d > 0.85 && now > r.laneUntil) {
          const t = tan[r.idx];
          const side = to.x * t.z - to.z * t.x; // >0 — машина справа от оси
          r.lane = side > 0 ? -3.5 : 3.5;
          r.laneUntil = now + 2.5;
        }
      }
      // Руль: на точку впереди по трассе, в своём ряду
      const look = 10 + Math.round(r.speed * 0.6);
      const ai = (r.idx + look) % N;
      const right = new Vector3(tan[ai].z, 0, -tan[ai].x);
      const aim = pts[ai].add(right.scale(r.lane));
      const want = Math.atan2(aim.x - mesh.position.x, aim.z - mesh.position.z);
      let dy = want - r.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      r.yaw += clamp(dy, -1.8 * dt, 1.8 * dt);
      // Перед поворотом тормозит: чем круче дуга впереди, тем медленнее
      const t0 = tan[r.idx];
      const t1 = tan[(r.idx + 24) % N];
      const bend = 1 - (t0.x * t1.x + t0.z * t1.z);
      // Догоняет, если сильно отстал от игрока, и не уезжает слишком далеко вперёд
      const gap = this.progress(this.player) - this.progress(r);
      const rubber = clamp(1 + gap * 0.03, 0.9, 1.08);
      const top = RACE_TOP_SPEED * r.skill * rubber * clamp(1 - bend * 1.6, 0.55, 1);
      r.speed += clamp(top - r.speed, -14 * dt, 8 * dt);
      const fwd = new Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      const before = mesh.position.clone();
      mesh.moveWithCollisions(fwd.scale(r.speed * dt));
      mesh.position.y = 0;
      if (Vector3.Distance(before, mesh.position) < r.speed * dt * 0.4) r.speed *= 0.5;
      mesh.rotation.y = r.yaw - Math.PI / 2;
      if (this.checkpoints(r, mesh.position) && !this.finished) {
        this.finished = r;
        return r;
      }
      // Стрельба: в машину впереди (игрока или другого бота)
      if (now >= r.nextShotAt) {
        r.nextShotAt = now + 1.4 + Math.random() * 1.6;
        const from = mesh.position.add(new Vector3(0, 1.3, 0));
        const targets: { pos: Vector3; hit: () => void }[] = [];
        if (pc.alive) targets.push({ pos: pc.pos, hit: () => this.host.damagePlayer(7) });
        for (const o of this.racers) {
          if (o === r || o.isPlayer || o.out || !o.mesh!.isEnabled()) continue;
          targets.push({ pos: o.mesh!.position, hit: () => this.damage(o, 7) });
        }
        for (const t of targets) {
          const to = t.pos.subtract(mesh.position);
          const d = Math.hypot(to.x, to.z);
          if (d > 35 || d < 1) continue;
          if ((to.x * fwd.x + to.z * fwd.z) / d < 0.75) continue;
          const end = t.pos.add(new Vector3(0, 1, 0));
          if (!this.host.clearLine(from, end)) continue;
          const vol = clamp(1 - Vector3.Distance(mesh.position, pc.pos) / 60, 0.1, 0.8);
          this.host.sfx.shot("strongPistol", vol);
          const hit = Math.random() < 0.5;
          this.host.effects.tracer(from, hit ? end : end.add(new Vector3(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1)), true);
          if (hit) t.hit();
          break;
        }
      }
    }
    return null;
  }

  /** Луч попал в машину соперника? */
  static racerOf(m: AbstractMesh | null | undefined): Racer | null {
    return (m?.metadata?.racer as Racer | undefined) ?? null;
  }

  aliveRivals(): number {
    return this.racers.filter((r) => !r.isPlayer && !r.out).length;
  }

  dispose(): void {
    for (const r of this.racers) r.mesh?.dispose();
  }
}

