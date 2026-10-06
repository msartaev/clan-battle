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
import { CLANS } from "@clan-battle/shared";
import { BODIES, type BodyId, getModels, gunKey } from "./models";

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
    const weapons: WeaponId[] = ["weakPistol", "strongPistol", "clanWeapon"];
    for (const w of weapons) {
      const gi = models.guns[gunKey(w, look.clan)].instantiateModelsToScene((n) => `${name}_${w}_${n}`, false, {
        doNotInstantiate: true,
      });
      const holder = new TransformNode(`${name}_gun_${w}`, scene);
      // Оружие висит на корне персонажа (без зеркального масштаба glTF) и каждый кадр встаёт в кисть
      holder.parent = this.root;
      const g = gi.rootNodes[0] as TransformNode;
      g.parent = holder;
      g.scaling.scaleInPlace(w === "clanWeapon" ? 0.5 : 0.42);
      for (const m of g.getChildMeshes(false)) {
        m.material = models.gunMat;
        this.meshes.push(m as Mesh);
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
    if (this.deathT > 0) return;
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
    // Руки: правая прямо по прицелу, левая — к правой кисти (хват двумя руками)
    aimBone(this.bone("UpperArm.R"), aim.add(right.scale(-0.05)).normalize(), 1);
    aimBone(this.bone("LowerArm.R"), aim, 1);
    aimBone(this.bone("UpperArm.L"), aim.add(right.scale(0.55)).normalize(), 1);
    aimBone(this.bone("LowerArm.L"), aim.add(right.scale(0.45)).normalize(), 1);
    aimBone(this.bone("Wrist.R"), aim, 1);
    this.placeGun();
  }

  /** Бластер — в правой кисти, ствол по линии прицела */
  private placeGun(): void {
    const wrist = this.bone("Wrist.R");
    this.root.getWorldMatrix().invertToRef(tmpM);
    const p = Vector3.TransformCoordinates(wrist.getAbsolutePosition(), tmpM);
    const g = this.guns.get(this.weapon);
    if (!g) return;
    g.position.copyFrom(p);
    g.position.y += 0.04;
    g.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, this.pitch, 0);
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
      // Падение назад, клипы замирают
      const t = Math.min(1, this.deathT);
      this.body.rotation.x = (-Math.PI / 2) * t * t;
      this.body.position.y = 0.15 * t;
      for (const g of this.move.values()) g.speedRatio = 0;
      return;
    }
    this.body.rotation.x = 0;
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
