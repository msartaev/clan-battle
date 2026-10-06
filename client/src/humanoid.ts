import {
  AnimationGroup,
  Color3,
  Matrix,
  Mesh,
  Observer,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { ClanId, WeaponId } from "@clan-battle/shared";
import { CLANS, SWORDS } from "@clan-battle/shared";
import { BODIES, type BodyId, getModels, gunKey, slingshotMesh, swordMesh } from "./models";

/**
 * Человек Quaternius Ultimate Modular (CC0): нормальные пропорции, одежда, скелет.
 * Ноги и корпус играют клипы Idle/Walk/Run, а руки после анимации наводятся на линию прицела;
 * присед и падение при смерти — процедурные поверх скелета.
 */

const matCache = new Map<string, StandardMaterial>();

export function flatMat(scene: Scene, hex: string, emissive = 0): StandardMaterial {
  const key = `${hex}|${emissive}`;
  let m = matCache.get(key);
  if (!m || m.getScene() !== scene) {
    m = new StandardMaterial(`mat_${key}`, scene);
    const c = Color3.FromHexString(hex);
    m.diffuseColor = c;
    m.specularColor = new Color3(0.06, 0.06, 0.06);
    if (emissive > 0) m.emissiveColor = c.scale(emissive);
    matCache.set(key, m);
  }
  return m;
}

export interface HumanoidLook {
  clan: ClanId;
  body: BodyId;
}

export function randomLook(clan: ClanId, rnd: () => number = Math.random): HumanoidLook {
  return { clan, body: BODIES[Math.floor(rnd() * BODIES.length)] };
}

/** Какая часть одежды перекрашивается в цвет клана у каждой модели */
const CLAN_GARMENT: Record<BodyId, string[]> = {
  casual_hoodie: ["Purple"],
  casual_2: ["LightBlue"],
  worker: ["Worker_Yellow"],
  w_casual: ["Orange"],
  beach: ["Red_Dark"],
  w_formal: ["Red"],
};

type MoveClip = "Idle" | "Walk" | "Run";
/** Скорость (м/с), при которой клип выглядит естественно */
const CLIP_SPEED: Record<MoveClip, number> = { Idle: 1, Walk: 1.6, Run: 4.5 };

const tmpM = new Matrix();
const tmpQ = new Quaternion();

/**
 * Поворачивает кость так, чтобы её ось (+Y, вдоль кости) смотрела в направлении dir (мир),
 * с силой amount (0 — как в анимации, 1 — точно в dir).
 * Считаем в пространстве родителя: в glTF-иерархии есть зеркальный масштаб (z = -1),
 * и разложение мировой матрицы на поворот там врёт.
 */
function aimBone(bone: TransformNode, dir: Vector3, amount: number): void {
  if (amount <= 0) return;
  const parent = bone.parent as TransformNode;
  parent.computeWorldMatrix(true);
  parent.getWorldMatrix().invertToRef(tmpM);
  const want = Vector3.TransformNormal(dir, tmpM).normalize();
  const cur = bone.rotationQuaternion ?? Quaternion.FromEulerVector(bone.rotation);
  const axis = Vector3.Up().rotateByQuaternionToRef(cur, new Vector3()).normalize();
  const target = Vector3.Lerp(axis, want, amount).normalize();
  Quaternion.FromUnitVectorsToRef(axis, target, tmpQ);
  bone.rotationQuaternion = tmpQ.multiply(cur);
  bone.computeWorldMatrix(true);
}

export class Humanoid {
  readonly root: TransformNode;
  /** Внутренний узел тела: присед и падение; root двигает владелец */
  readonly body: TransformNode;
  /** Точка вылета пули (кончик ствола) */
  readonly muzzle: TransformNode;
  readonly meshes: Mesh[] = [];
  private model: TransformNode;
  private bones = new Map<string, TransformNode>();
  private move = new Map<MoveClip, AnimationGroup>();
  private weights = new Map<MoveClip, number>();
  private guns = new Map<WeaponId, TransformNode>();
  private muzzles = new Map<WeaponId, TransformNode>();
  private weapon: WeaponId = "weakPistol";
  private swords: Mesh[] = [];
  /** 0..1: идёт взмах мечом (1 — начало) */
  private swingT = 0;
  /** Меч держат ровно, как щит */
  blocking = false;
  private pitch = 0;
  private crouchT = 0;
  private afterAnim: Observer<Scene> | null;
  /** 0..1 — падение при смерти */
  deathT = 0;

  constructor(private scene: Scene, name: string, look: HumanoidLook) {
    const models = getModels();
    this.root = new TransformNode(`${name}_root`, scene);
    this.body = new TransformNode(`${name}_body`, scene);
    this.body.parent = this.root;

    const prefix = `${name}_`;
    const inst = models.humans[look.body].instantiateModelsToScene((n) => prefix + n, false, { doNotInstantiate: true });
    this.model = inst.rootNodes[0] as TransformNode;
    this.model.parent = this.body;
    for (const d of this.model.getDescendants(false)) this.bones.set(d.name.slice(prefix.length), d as TransformNode);

    // Одежда: основная вещь в цвет клана, остальное — цвета модели
    const garment = CLAN_GARMENT[look.body];
    for (const m of this.model.getChildMeshes(false)) {
      const part = m.material?.name ?? "";
      m.material = models.humanMat(look.body, part, garment.includes(part) ? CLANS[look.clan].color : undefined);
      this.meshes.push(m as Mesh);
    }

    for (const g of inst.animationGroups) {
      const clip = g.name.replace(prefix, "") as MoveClip;
      if (clip in CLIP_SPEED) {
        g.play(true);
        g.weight = clip === "Idle" ? 1 : 0;
        this.weights.set(clip, g.weight);
        this.move.set(clip, g);
      } else {
        g.dispose();
      }
    }

    this.afterAnim = scene.onAfterAnimationsObservable.add(() => this.afterAnimations());

    // Бластеры в правой кисти; ориентацию подбираем по первому кадру позы прицела
    const weapons: WeaponId[] = ["weakPistol", "strongPistol", "clanWeapon", "slingshot", "sword"];
    for (const w of weapons) {
      const holder = new TransformNode(`${name}_gun_${w}`, scene);
      // Оружие висит на корне персонажа (без зеркального масштаба glTF) и каждый кадр встаёт в кисть
      holder.parent = this.root;
      const key = gunKey(w, look.clan);
      if (key) {
        const gi = models.guns[key].instantiateModelsToScene((n) => `${name}_${w}_${n}`, false, { doNotInstantiate: true });
        const g = gi.rootNodes[0] as TransformNode;
        g.parent = holder;
        g.scaling.scaleInPlace(w === "clanWeapon" ? 0.5 : 0.42);
        for (const m of g.getChildMeshes(false)) {
          m.material = models.gunMat;
          this.meshes.push(m as Mesh);
        }
      } else if (w === "sword") {
        // Два уровня меча; виден тот, что сейчас у бойца
        SWORDS[look.clan].slice(0, 2).forEach((sw, lvl) => {
          const m = swordMesh(scene, `${name}_sword${lvl + 1}`, look.clan, sw.length);
          m.parent = holder;
          m.setEnabled(lvl === 0);
          this.swords.push(m);
          this.meshes.push(m);
        });
      } else {
        const sl = slingshotMesh(scene, `${name}_sling`);
        sl.parent = holder;
        this.meshes.push(sl);
      }
      const muzzle = new TransformNode(`${name}_muzzle_${w}`, scene);
      muzzle.parent = holder;
      muzzle.position.set(0, 0.03, w === "clanWeapon" ? 0.4 : 0.25);
      this.guns.set(w, holder);
      this.muzzles.set(w, muzzle);
    }
    this.muzzle = this.muzzles.get("weakPistol")!;
    this.setWeapon("weakPistol");

    for (const m of this.meshes) m.isPickable = false;
  }

  private bone(n: string): TransformNode {
    const b = this.bones.get(n);
    if (!b) throw new Error(`В скелете нет кости ${n}`);
    return b;
  }

  private afterAnimations(): void {
    if (this.deathT > 0) {
      this.deathPose();
      return;
    }
    this.root.computeWorldMatrix(true);
    const fwd = this.root.getDirection(Vector3.Forward()).normalize();
    const right = this.root.getDirection(Vector3.Right()).normalize();
    const down = new Vector3(0, -1, 0);
    // Линия прицела с учётом наклона камеры
    const aim = fwd.scale(Math.cos(this.pitch)).add(down.scale(Math.sin(this.pitch))).normalize();
    const c = this.crouchT;

    // Ноги в приседе: бедро вперёд, голень вниз
    if (c > 0.01) {
      const thigh = fwd.scale(0.85).add(down.scale(0.5)).normalize();
      const shin = down.add(fwd.scale(-0.35)).normalize();
      for (const s of ["L", "R"]) {
        aimBone(this.bone(`UpperLeg.${s}`), thigh, c);
        aimBone(this.bone(`LowerLeg.${s}`), shin, c);
      }
    }
    // Меч: щит — клинок поперёк груди; взмах — рука идёт сверху-справа вниз-влево
    if (this.weapon === "sword") {
      const up = new Vector3(0, 1, 0);
      let dir: Vector3;
      if (this.swingT > 0) {
        const s = this.swingT; // 1 → 0
        dir = aim.add(right.scale(0.9 * (2 * s - 1))).add(up.scale(0.7 * s - 0.2)).normalize();
      } else if (this.blocking) {
        dir = aim.add(right.scale(-0.4)).add(up.scale(0.25)).normalize();
      } else {
        dir = aim.add(down.scale(0.35)).normalize();
      }
      aimBone(this.bone("UpperArm.R"), dir, 1);
      aimBone(this.bone("LowerArm.R"), dir, 1);
      aimBone(this.bone("Wrist.R"), dir, 1);
      aimBone(this.bone("UpperArm.L"), down.add(fwd.scale(0.3)).add(right.scale(-0.2)).normalize(), 1);
      aimBone(this.bone("LowerArm.L"), down.add(fwd.scale(0.4)).normalize(), 1);
      this.placeGun(dir);
      return;
    }
    // Руки: правая прямо по прицелу, левая — к правой кисти (хват двумя руками)
    aimBone(this.bone("UpperArm.R"), aim.add(right.scale(-0.05)).normalize(), 1);
    aimBone(this.bone("LowerArm.R"), aim, 1);
    aimBone(this.bone("UpperArm.L"), aim.add(right.scale(0.55)).normalize(), 1);
    aimBone(this.bone("LowerArm.L"), aim.add(right.scale(0.45)).normalize(), 1);
    aimBone(this.bone("Wrist.R"), aim, 1);
    this.placeGun();
  }

  /**
   * Смерть: колени подламываются, тело оседает и заваливается на спину,
   * руки опускаются и раскидываются в стороны. Всё поверх замершего клипа.
   */
  private deathPose(): void {
    const t = Math.min(1, this.deathT);
    const k1 = Math.min(1, t / 0.35); // колени
    const k2 = Math.max(0, Math.min(1, (t - 0.25) / 0.75)); // падение
    const fall = k2 * k2 * (3 - 2 * k2); // плавный старт и мягкая «посадка»
    this.body.rotation.x = (-Math.PI / 2) * fall;
    // Сначала оседаем на подогнутых ногах, потом ложимся; бёдра остаются примерно на месте
    this.body.position.y = -0.38 * k1 * (1 - fall) + 0.12 * fall;
    this.body.position.z = -0.55 * fall;

    this.root.computeWorldMatrix(true);
    this.body.computeWorldMatrix(true);
    // Направления в мире с учётом наклона тела
    const up = this.body.getDirection(Vector3.Up()).normalize();
    const fwd = this.body.getDirection(Vector3.Forward()).normalize();
    const right = this.body.getDirection(Vector3.Right()).normalize();
    const down = up.scale(-1);
    // Ноги: бедро вперёд, голень вниз — как подкошенный; к концу падения ноги чуть выпрямляются
    const bend = k1 * (1 - 0.6 * fall);
    const thigh = down.add(fwd.scale(0.9 * bend)).normalize();
    const shin = down.add(fwd.scale(-0.5 * bend)).normalize();
    for (const s of ["L", "R"]) {
      aimBone(this.bone(`UpperLeg.${s}`), thigh, 1);
      aimBone(this.bone(`LowerLeg.${s}`), shin, 1);
    }
    // Руки: сперва висят, потом раскинуты в стороны (по телу — вверх-наружу)
    for (const [s, side] of [["L", -1], ["R", 1]] as const) {
      const hang = down.add(right.scale(0.25 * side)).normalize();
      const spread = right.scale(side).add(up.scale(0.45)).add(fwd.scale(-0.2)).normalize();
      const dir = Vector3.Lerp(hang, spread, fall).normalize();
      aimBone(this.bone(`UpperArm.${s}`), dir, 1);
      aimBone(this.bone(`LowerArm.${s}`), dir, 1);
    }
    this.placeGun();
  }

  /** Бластер — в правой кисти, ствол по линии прицела */
  private placeGun(dirWorld?: Vector3): void {
    const wrist = this.bone("Wrist.R");
    this.root.getWorldMatrix().invertToRef(tmpM);
    const p = Vector3.TransformCoordinates(wrist.getAbsolutePosition(), tmpM);
    const g = this.guns.get(this.weapon);
    if (!g) return;
    g.position.copyFrom(p);
    g.position.y += 0.04;
    if (dirWorld) {
      // Клинок по направлению руки (в системе корня персонажа)
      const d = Vector3.TransformNormal(dirWorld, tmpM).normalize();
      g.rotationQuaternion = Quaternion.FromLookDirectionLH(d, Vector3.Up());
    } else {
      g.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, this.pitch, 0);
    }
  }

  setSwordLevel(level: number): void {
    this.swords.forEach((m, i) => m.setEnabled(i === level - 1));
  }

  /** Начать взмах (для вида от третьего лица) */
  swing(): void {
    this.swingT = 1;
  }

  setWeapon(id: WeaponId): void {
    this.weapon = id;
    for (const [k, g] of this.guns) g.setEnabled(k === id);
  }

  setVisible(v: boolean): void {
    for (const m of this.meshes) m.isVisible = v;
  }

  setEnabled(v: boolean): void {
    this.root.setEnabled(v);
  }

  /**
   * @param speed скорость движения, м/с
   * @param crouch присел ли
   * @param pitch наклон прицела (как у камеры: > 0 — вниз)
   * @param airborne в прыжке
   */
  animate(dt: number, speed: number, crouch: boolean, pitch: number, airborne: boolean): void {
    this.pitch = pitch;
    if (this.deathT > 0) {
      // Клипы замирают на стойке; позу смерти строит deathPose() после анимации
      for (const [c, g] of this.move) {
        g.weight = c === "Idle" ? 1 : 0;
        this.weights.set(c, g.weight);
        g.speedRatio = 0;
      }
      return;
    }
    this.body.rotation.x = 0;
    this.body.position.z = 0;
    this.swingT = Math.max(0, this.swingT - dt / 0.35);
    this.crouchT += ((crouch ? 1 : 0) - this.crouchT) * Math.min(1, dt * 12);
    this.body.position.y = -0.42 * this.crouchT;

    const clip: MoveClip = airborne || speed < 0.3 ? "Idle" : speed < 2.6 ? "Walk" : "Run";
    const k = Math.min(1, dt * 8);
    for (const [c, g] of this.move) {
      const w = (this.weights.get(c) ?? 0) + ((c === clip ? 1 : 0) - (this.weights.get(c) ?? 0)) * k;
      this.weights.set(c, w);
      g.weight = w;
      g.speedRatio = c === "Idle" ? 1 : Math.min(1.6, Math.max(0.6, speed / CLIP_SPEED[c])) * (crouch ? 0.8 : 1);
    }
  }

  getMuzzlePosition(): Vector3 {
    return (this.muzzles.get(this.weapon) ?? this.muzzle).getAbsolutePosition().clone();
  }

  dispose(): void {
    if (this.afterAnim) this.scene.onAfterAnimationsObservable.remove(this.afterAnim);
    this.afterAnim = null;
    for (const g of this.move.values()) g.dispose();
    this.root.dispose(false, false);
  }
}
