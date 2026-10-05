import { Color3, InstancedMesh, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";

/** Светящийся материал без освещения */
function glowMat(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const c = Color3.FromHexString(hex);
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = c;
  m.disableLighting = true;
  return m;
}

interface Spark {
  mesh: InstancedMesh;
  vel: Vector3;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
}

/** Пул «искр» — маленьких светящихся частиц одного цвета */
class SparkPool {
  private base: Mesh;
  private free: InstancedMesh[] = [];
  private active: Spark[] = [];

  constructor(scene: Scene, name: string, hex: string, private capacity: number) {
    this.base = MeshBuilder.CreateIcoSphere(`${name}_spark`, { radius: 0.5, subdivisions: 0, flat: true }, scene);
    this.base.material = glowMat(scene, `${name}_mat`, hex);
    this.base.isPickable = false;
    this.base.isVisible = false;
    for (let i = 0; i < capacity; i++) {
      const inst = this.base.createInstance(`${name}_s${i}`);
      inst.isPickable = false;
      inst.setEnabled(false);
      this.free.push(inst);
    }
  }

  emit(pos: Vector3, count: number, speed: number, size: number, life: number, gravity = 0, up = 0): void {
    for (let i = 0; i < count; i++) {
      let mesh = this.free.pop();
      if (!mesh) {
        // Переиспользуем самую старую
        const old = this.active.shift();
        if (!old) return;
        mesh = old.mesh;
      }
      mesh.setEnabled(true);
      mesh.position.copyFrom(pos);
      const v = new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1 + up, Math.random() * 2 - 1);
      v.normalize().scaleInPlace(speed * (0.4 + Math.random() * 0.6));
      const l = life * (0.6 + Math.random() * 0.4);
      this.active.push({ mesh, vel: v, life: l, maxLife: l, size, gravity });
    }
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i];
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.setEnabled(false);
        this.free.push(s.mesh);
        this.active.splice(i, 1);
        continue;
      }
      s.vel.y -= s.gravity * dt;
      s.mesh.position.addInPlace(s.vel.scale(dt));
      const k = s.size * (s.life / s.maxLife);
      s.mesh.scaling.set(k, k, k);
    }
  }

  get size(): number {
    return this.capacity;
  }
}

interface Tracer {
  mesh: Mesh;
  life: number;
}

interface Orb {
  mesh: Mesh;
  from: Vector3;
  to: Vector3;
  t: number;
  dur: number;
  kind: "fire" | "poison";
  onHit: () => void;
}

export class Effects {
  private tracers: Tracer[] = [];
  private freeTracers: Mesh[] = [];
  private tracerMat: StandardMaterial;
  private enemyTracerMat: StandardMaterial;
  private dust: SparkPool;
  private hit: SparkPool;
  private fire: SparkPool;
  private poison: SparkPool;
  private orbs: Orb[] = [];
  private orbFree: { fire: Mesh[]; poison: Mesh[] } = { fire: [], poison: [] };
  private orbMats: { fire: StandardMaterial; poison: StandardMaterial };
  private flash: Mesh;
  private flashLife = 0;

  constructor(private scene: Scene, lowFx: boolean) {
    this.tracerMat = glowMat(scene, "tracerMat", "#fff2a8");
    this.enemyTracerMat = glowMat(scene, "tracerEnemyMat", "#ffb0a0");
    const n = lowFx ? 0.5 : 1;
    this.dust = new SparkPool(scene, "dust", "#d8cdb5", Math.round(60 * n));
    this.hit = new SparkPool(scene, "hit", "#ffe14a", Math.round(60 * n));
    this.fire = new SparkPool(scene, "fire", "#ff7a1a", Math.round(140 * n));
    this.poison = new SparkPool(scene, "poison", "#8aff3a", Math.round(140 * n));
    this.orbMats = { fire: glowMat(scene, "orbFire", "#ffb347"), poison: glowMat(scene, "orbPoison", "#a8ff5a") };
    this.flash = MeshBuilder.CreateIcoSphere("muzzleFlash", { radius: 0.09, subdivisions: 1 }, scene);
    this.flash.material = glowMat(scene, "flashMat", "#fff6c0");
    this.flash.isPickable = false;
    this.flash.setEnabled(false);
    this.flash.renderingGroupId = 1;
  }

  tracer(from: Vector3, to: Vector3, enemy = false): void {
    let mesh = this.freeTracers.pop();
    if (!mesh) {
      mesh = MeshBuilder.CreateBox("tracer", { width: 0.025, height: 0.025, depth: 1 }, this.scene);
      mesh.isPickable = false;
    }
    mesh.material = enemy ? this.enemyTracerMat : this.tracerMat;
    mesh.setEnabled(true);
    const len = Vector3.Distance(from, to);
    // Трассер короче полного пути — так выглядит как пуля
    const vis = Math.min(len, 6);
    const dir = to.subtract(from).normalize();
    const start = to.subtract(dir.scale(vis));
    mesh.position.copyFrom(Vector3.Center(start, to));
    mesh.scaling.set(1, 1, vis);
    mesh.lookAt(to);
    this.tracers.push({ mesh, life: 0.07 });
  }

  muzzleFlash(pos: Vector3): void {
    this.flash.position.copyFrom(pos);
    this.flash.setEnabled(true);
    this.flash.rotation.z = Math.random() * 3;
    this.flashLife = 0.05;
  }

  impact(pos: Vector3, onBody: boolean): void {
    if (onBody) this.hit.emit(pos, 8, 3.5, 0.09, 0.3, 4);
    else this.dust.emit(pos, 6, 2, 0.08, 0.35, 5, 0.6);
  }

  clanBurst(pos: Vector3, kind: "fire" | "poison"): void {
    const pool = kind === "fire" ? this.fire : this.poison;
    pool.emit(pos, 16, kind === "fire" ? 4 : 3, 0.18, 0.55, kind === "fire" ? -2 : 4, kind === "fire" ? 0.8 : 0.2);
  }

  /** Летящий заряд кланового оружия: огонь дракона или яд змеи */
  orb(from: Vector3, to: Vector3, kind: "fire" | "poison", speed: number, onHit: () => void): void {
    let mesh = this.orbFree[kind].pop();
    if (!mesh) {
      mesh = MeshBuilder.CreateIcoSphere(`orb_${kind}`, { radius: 0.16, subdivisions: 1 }, this.scene);
      mesh.material = this.orbMats[kind];
      mesh.isPickable = false;
    }
    mesh.setEnabled(true);
    mesh.position.copyFrom(from);
    const dur = Math.max(0.04, Vector3.Distance(from, to) / speed);
    this.orbs.push({ mesh, from: from.clone(), to: to.clone(), t: 0, dur, kind, onHit });
  }

  update(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.setEnabled(false);
        this.freeTracers.push(t.mesh);
        this.tracers.splice(i, 1);
      }
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      if (this.flashLife <= 0) this.flash.setEnabled(false);
    }
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.t += dt;
      const k = Math.min(1, o.t / o.dur);
      Vector3.LerpToRef(o.from, o.to, k, o.mesh.position);
      const s = 1 + Math.sin(o.t * 40) * 0.2;
      o.mesh.scaling.set(s, s, s);
      // Хвост из искр
      const pool = o.kind === "fire" ? this.fire : this.poison;
      pool.emit(o.mesh.position, 1, 0.6, 0.13, 0.3, o.kind === "fire" ? -1.5 : 2);
      if (k >= 1) {
        o.mesh.setEnabled(false);
        this.orbFree[o.kind].push(o.mesh);
        this.orbs.splice(i, 1);
        this.clanBurst(o.to, o.kind);
        o.onHit();
      }
    }
    this.dust.update(dt);
    this.hit.update(dt);
    this.fire.update(dt);
    this.poison.update(dt);
  }

  clearOrbs(): void {
    for (const o of this.orbs) {
      o.mesh.setEnabled(false);
      this.orbFree[o.kind].push(o.mesh);
    }
    this.orbs.length = 0;
  }
}

/** Крошечный синтезатор звуков на WebAudio — без файлов */
export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const len = Math.floor(this.ctx.sampleRate * 0.3);
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  private burst(freq: number, dur: number, vol: number, type: BiquadFilterType = "lowpass"): void {
    if (!this.ctx || !this.noise || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(this.ctx.destination);
      src.start(t);
      src.stop(t + dur);
    } catch {
      /* звук не обязателен */
    }
  }

  private tone(freq: number, dur: number, vol: number, slide = 0): void {
    if (!this.ctx || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur);
    } catch {
      /* звук не обязателен */
    }
  }

  shot(weapon: "weakPistol" | "strongPistol" | "clanWeapon", distanceVol = 1): void {
    if (weapon === "weakPistol") this.burst(2600, 0.08, 0.18 * distanceVol);
    else if (weapon === "strongPistol") this.burst(1400, 0.16, 0.3 * distanceVol);
    else {
      this.burst(900, 0.25, 0.22 * distanceVol, "bandpass");
      this.tone(320, 0.2, 0.08 * distanceVol, 0.5);
    }
  }

  hit(): void {
    this.tone(1200, 0.06, 0.08);
  }

  kill(): void {
    this.tone(660, 0.12, 0.12, 1.5);
  }

  hurt(): void {
    this.tone(180, 0.15, 0.15, 0.6);
  }

  pickup(): void {
    this.tone(880, 0.1, 0.1, 1.5);
  }

  empty(): void {
    this.tone(300, 0.04, 0.06);
  }
}
