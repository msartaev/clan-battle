import { AnimationGroup, Color3, Mesh, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { getModels } from "./models";
import { angleDiff, clamp } from "./utils";

/**
 * Звери живого мира: волки (стаей, нападают сами), медведь и лось (мирные, пока их не ранят).
 * Модели Quaternius (CC0): волк и олень; медведь — это волк крупнее и бурый, лось — олень крупнее и темнее.
 */

export type AnimalKind = "wolf" | "bear" | "moose";

interface KindInfo {
  model: "wolf" | "stag";
  /** Масштаб модели: x — ширина, y — высота, z — длина */
  scale: [number, number, number];
  /** Цвета частей: имя материала модели → цвет */
  colors: Record<string, string>;
  hp: number;
  /** Урон за укус/удар и пауза между ними */
  damage: number;
  attackEvery: number;
  walk: number;
  run: number;
  /** Нападает сам на любого, кто подошёл ближе */
  hostile: boolean;
  /** Высота и толщина тела для попаданий */
  height: number;
  radius: number;
  name: string;
}

export const ANIMALS: Record<AnimalKind, KindInfo> = {
  wolf: {
    model: "wolf",
    scale: [1.25, 1.25, 1.25],
    colors: { Main: "#5d5850", Main_Light: "#9a948a", Nose: "#111111", Eyes_Black: "#050505" },
    hp: 60,
    damage: 9,
    attackEvery: 0.9,
    walk: 1.6,
    run: 6.6,
    hostile: true,
    height: 0.85,
    radius: 0.42,
    name: "Волк",
  },
  bear: {
    model: "wolf",
    scale: [2.6, 2.05, 1.45],
    colors: { Main: "#4a3121", Main_Light: "#6b4a33", Nose: "#140c08", Eyes_Black: "#050505" },
    hp: 220,
    damage: 26,
    attackEvery: 1.4,
    walk: 1.1,
    run: 5.2,
    hostile: false,
    height: 1.25,
    radius: 0.7,
    name: "Медведь",
  },
  moose: {
    model: "stag",
    scale: [1.3, 1.3, 1.35],
    colors: { Material: "#3a2617", "Material.001": "#4d3220", "Material.003": "#5e4630", "Material.010": "#0a0a0a", "Material.011": "#0a0a0a" },
    hp: 160,
    damage: 20,
    attackEvery: 1.3,
    walk: 1.4,
    run: 6.2,
    hostile: false,
    height: 2.1,
    radius: 0.65,
    name: "Лось",
  },
};

/** Тот, на кого зверь может напасть (игрок или бот) — даёт игра */
export interface Prey {
  pos: Vector3;
  readonly alive: boolean;
  hurt(dmg: number, from: Vector3): void;
}

const matCache = new Map<string, StandardMaterial>();
function colorMat(scene: Scene, hex: string): StandardMaterial {
  let m = matCache.get(hex);
  if (!m || m.getScene() !== scene) {
    m = new StandardMaterial(`animal_${hex}`, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor.set(0.04, 0.04, 0.04);
    matCache.set(hex, m);
  }
  return m;
}

let counter = 0;

export class Animal {
  readonly id = ++counter;
  readonly info: KindInfo;
  readonly root: TransformNode;
  readonly meshes: Mesh[] = [];
  hp: number;
  yaw = 0;
  /** На кого злится: волк — на ближайшего, медведь и лось — на обидчика */
  target: Prey | null = null;
  private angryUntil = 0;
  private goal = new Vector3();
  private clips = new Map<string, AnimationGroup>();
  private current = "";
  private attackCd = 0;
  private deadTimer = 0;
  private home: Vector3;
  /** Заморожен бомбой до этого момента */
  frozenUntil = -1;
  /** Прилип (липучка): не ходит, но кусает, если жертва рядом */
  stuckUntil = -1;

  constructor(
    scene: Scene,
    readonly kind: AnimalKind,
    home: Vector3,
  ) {
    this.info = ANIMALS[kind];
    this.hp = this.info.hp;
    this.home = home.clone();
    const models = getModels();
    const prefix = `animal${this.id}_`;
    const inst = models.animals[this.info.model].instantiateModelsToScene((n) => prefix + n, false, { doNotInstantiate: true });
    this.root = new TransformNode(`animal${this.id}`, scene);
    const model = inst.rootNodes[0] as TransformNode;
    model.parent = this.root;
    const [sx, sy, sz] = this.info.scale;
    model.scaling.set(model.scaling.x * sx, model.scaling.y * sy, model.scaling.z * sz);
    for (const m of model.getChildMeshes(false)) {
      const c = this.info.colors[m.material?.name ?? ""];
      if (c) m.material = colorMat(scene, c);
      m.isPickable = false;
      this.meshes.push(m as Mesh);
    }
    for (const g of inst.animationGroups) {
      g.stop();
      this.clips.set(g.name.replace(prefix, ""), g);
    }
    this.spawn(home);
  }

  get pos(): Vector3 {
    return this.root.position;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** Злится ли сейчас (для ботов: этот зверь опасен) */
  get angry(): boolean {
    return this.alive && !!this.target;
  }

  spawn(at: Vector3): void {
    this.hp = this.info.hp;
    this.root.position.set(at.x, 0, at.z);
    this.root.setEnabled(true);
    this.target = null;
    this.goal.copyFrom(at);
    this.deadTimer = 0;
    this.play("Idle");
  }

  private play(name: string, loop = true, speed = 1): void {
    const g = this.clips.get(name) ?? this.clips.get("Idle");
    if (!g) return;
    if (g.speedRatio === 0) g.speedRatio = speed;
    if (this.current === name) {
      g.speedRatio = speed;
      return;
    }
    for (const c of this.clips.values()) c.stop();
    g.start(loop, speed);
    this.current = name;
  }

  /** Ранили. Возвращает true, если зверь погиб */
  takeDamage(dmg: number, from: Prey | null, now: number): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - dmg);
    if (this.hp <= 0) {
      this.target = null;
      this.play("Death", false);
      return true;
    }
    // Обидчика запоминает надолго — и мирный медведь превращается в опасного
    if (from) {
      this.target = from;
      this.angryUntil = now + 25;
    }
    return false;
  }

  update(
    dt: number,
    now: number,
    prey: Prey[],
    walkPoint: (near: Vector3, r: number) => Vector3,
    walkable: (x: number, z: number) => boolean,
    ground: (x: number, z: number) => number = () => 0,
  ): void {
    if (!this.alive) {
      this.deadTimer += dt;
      if (this.deadTimer > 4) this.root.setEnabled(false);
      // Через минуту на месте погибшего появляется новый зверь
      if (this.deadTimer > 60) this.spawn(walkPoint(this.home, 12));
      return;
    }
    const pos = this.pos;
    if (now < this.frozenUntil) {
      for (const c of this.clips.values()) c.speedRatio = 0;
      return;
    }
    // Волк сам ищет ближайшую жертву; остальные злятся только на обидчика
    if (this.info.hostile) {
      if (!this.target || !this.target.alive || Vector3.DistanceSquared(this.target.pos, pos) > 28 * 28) {
        this.target = null;
        let best = 16 * 16;
        for (const p of prey) {
          if (!p.alive) continue;
          const d = Vector3.DistanceSquared(p.pos, pos);
          if (d < best) {
            best = d;
            this.target = p;
          }
        }
      }
    } else if (this.target && (!this.target.alive || now > this.angryUntil)) {
      this.target = null;
    }

    let speed = 0;
    let face: Vector3 | null = null;
    this.attackCd -= dt;
    if (this.target) {
      const to = this.target.pos.subtract(pos);
      to.y = 0;
      const dist = to.length();
      face = this.target.pos;
      const reach = this.info.radius + 1.1;
      if (dist > reach) {
        speed = this.info.run;
        this.play("Gallop", true, clamp(speed / 6, 0.8, 1.3));
      } else if (this.attackCd <= 0) {
        this.attackCd = this.info.attackEvery;
        this.play(this.clips.has("Attack") ? "Attack" : "Attack_Headbutt", false);
        this.target.hurt(this.info.damage, pos.clone());
      }
    } else {
      // Пасётся и бродит рядом с домом
      if (Vector3.DistanceSquared(pos, this.goal) < 1.5) {
        this.goal = Math.random() < 0.5 ? pos.clone() : walkPoint(this.home, 14);
      }
      if (Vector3.DistanceSquared(pos, this.goal) > 1.5) {
        speed = this.info.walk;
        face = this.goal;
        this.play("Walk", true, 0.9);
      } else {
        this.play(Math.random() < 0.003 ? "Eating" : this.current === "Eating" ? "Eating" : "Idle");
      }
    }
    if (face) {
      const d = face.subtract(pos);
      const want = Math.atan2(d.x, d.z);
      this.yaw += clamp(angleDiff(this.yaw, want), -4 * dt, 4 * dt);
    }
    if (now < this.stuckUntil) speed = 0;
    if (speed > 0) {
      // Сквозь дома и машины не ходит: если прямо нельзя — пробует обойти под углом
      let moved = false;
      for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
        const a = this.yaw + off;
        const nx = pos.x + Math.sin(a) * speed * dt;
        const nz = pos.z + Math.cos(a) * speed * dt;
        if (walkable(nx, nz)) {
          pos.set(nx, ground(nx, nz), nz);
          moved = true;
          break;
        }
      }
      if (!moved && !this.target) this.goal = walkPoint(this.home, 14);
    }
    this.root.rotation.y = this.yaw;
  }
}
