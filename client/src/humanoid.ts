import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CLANS, type ClanId, type WeaponId } from "@clan-battle/shared";

/**
 * Человечек с реалистичными пропорциями (рост ~1.8 м), собранный из простых фигур.
 * Кости — TransformNode, процедурная анимация ходьбы, приседа и прицеливания.
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
  skin: string;
  pants: string;
  hair: string;
}

const SKINS = ["#f1c7a5", "#e0ac84", "#c68b62", "#8d5a3b"];
const HAIRS = ["#2b1d14", "#5a3a1e", "#c9a35a", "#1a1a1a", "#7a3b1a"];

export function randomLook(clan: ClanId, rnd: () => number = Math.random): HumanoidLook {
  return {
    clan,
    skin: SKINS[Math.floor(rnd() * SKINS.length)],
    hair: HAIRS[Math.floor(rnd() * HAIRS.length)],
    pants: rnd() < 0.5 ? "#2e3442" : "#4a3b2a",
  };
}

export class Humanoid {
  readonly root: TransformNode;
  /** Внутренний узел тела: на нём анимация падения, root двигает владелец */
  readonly body: TransformNode;
  readonly pelvis: TransformNode;
  readonly spine: TransformNode;
  readonly head: TransformNode;
  readonly hipL: TransformNode;
  readonly hipR: TransformNode;
  readonly kneeL: TransformNode;
  readonly kneeR: TransformNode;
  readonly shoulderL: TransformNode;
  readonly shoulderR: TransformNode;
  readonly elbowL: TransformNode;
  readonly elbowR: TransformNode;
  readonly handR: TransformNode;
  /** Точка вылета пули (кончик ствола) */
  readonly muzzle: TransformNode;
  readonly meshes: Mesh[] = [];
  private guns = new Map<WeaponId, TransformNode>();
  private phase = 0;
  private crouchT = 0;
  /** 0..1 — падение при смерти */
  deathT = 0;

  constructor(private scene: Scene, name: string, look: HumanoidLook) {
    const clan = CLANS[look.clan];
    const shirt = flatMat(scene, clan.color);
    const accent = flatMat(scene, clan.accent);
    const skin = flatMat(scene, look.skin);
    const pants = flatMat(scene, look.pants);
    const hair = flatMat(scene, look.hair);
    const boots = flatMat(scene, "#2a211b");
    const dark = flatMat(scene, "#22252b");

    this.root = new TransformNode(`${name}_root`, scene);
    this.body = this.node("body", this.root, 0, 0, 0);
    this.pelvis = this.node("pelvis", this.body, 0, 0.95, 0);

    // Таз
    this.box("pelvisM", this.pelvis, pants, 0.34, 0.2, 0.22, 0, 0, 0);
    // Ремень
    this.box("belt", this.pelvis, dark, 0.35, 0.05, 0.23, 0, 0.1, 0);

    // Ноги
    this.hipL = this.node("hipL", this.pelvis, -0.1, -0.04, 0);
    this.hipR = this.node("hipR", this.pelvis, 0.1, -0.04, 0);
    this.kneeL = this.leg(this.hipL, pants, boots, "L");
    this.kneeR = this.leg(this.hipR, pants, boots, "R");

    // Корпус
    this.spine = this.node("spine", this.pelvis, 0, 0.08, 0);
    this.box("abdomen", this.spine, shirt, 0.33, 0.24, 0.2, 0, 0.12, 0);
    this.box("chest", this.spine, shirt, 0.42, 0.3, 0.24, 0, 0.37, 0);
    // Клановая нашивка и разгрузка
    this.box("emblem", this.spine, accent, 0.14, 0.14, 0.02, 0.0, 0.4, 0.125);
    this.box("strap", this.spine, dark, 0.06, 0.5, 0.25, -0.08, 0.3, 0).rotation.z = -0.5;
    // Шея и голова
    this.cyl("neck", this.spine, skin, 0.1, 0.1, 0, 0.56, 0);
    this.head = this.node("head", this.spine, 0, 0.66, 0);
    const headM = MeshBuilder.CreateSphere(`${name}_headM`, { diameter: 1, segments: 8 }, scene);
    headM.scaling.set(0.2, 0.24, 0.22);
    headM.parent = this.head;
    headM.material = skin;
    this.meshes.push(headM);
    // Волосы/шапка
    const cap = MeshBuilder.CreateSphere(`${name}_hair`, { diameter: 1, segments: 8, slice: 0.55 }, scene);
    cap.scaling.set(0.215, 0.25, 0.235);
    cap.position.y = 0.015;
    cap.parent = this.head;
    cap.material = hair;
    this.meshes.push(cap);
    // Повязка клана
    this.box("band", this.head, accent, 0.215, 0.04, 0.235, 0, 0.05, 0);
    // Нос — чтобы было видно, куда смотрит
    this.box("nose", this.head, skin, 0.035, 0.05, 0.04, 0, -0.01, 0.11);

    // Руки
    this.shoulderL = this.node("shL", this.spine, -0.25, 0.48, 0);
    this.shoulderR = this.node("shR", this.spine, 0.25, 0.48, 0);
    this.elbowL = this.arm(this.shoulderL, shirt, skin, "L");
    this.elbowR = this.arm(this.shoulderR, shirt, skin, "R");
    this.handR = this.node("handR", this.elbowR, 0, -0.27, 0);

    // Оружие в правой руке: ствол смотрит вдоль -Y кисти
    this.muzzle = this.node("muzzle", this.handR, 0, -0.3, 0.02);
    this.guns.set("weakPistol", this.makeGun("weak", dark, 0.2, 0.045));
    this.guns.set("strongPistol", this.makeGun("strong", flatMat(scene, "#3a3f4a"), 0.3, 0.06));
    this.guns.set("clanWeapon", this.makeClanGun(accent, shirt, look.clan));
    this.setWeapon("weakPistol");

    for (const m of this.meshes) {
      // Персонажи двигаются, поэтому рамку для отсечения пересчитываем каждый кадр:
      // с doNotSyncBoundingInfo тело пропадало, стоило отойти от точки появления
      m.isPickable = false;
    }
  }

  private node(n: string, parent: TransformNode, x: number, y: number, z: number): TransformNode {
    const t = new TransformNode(`${this.root.name}_${n}`, this.scene);
    t.parent = parent;
    t.position.set(x, y, z);
    return t;
  }

  private box(
    n: string,
    parent: TransformNode,
    mat: StandardMaterial,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const m = MeshBuilder.CreateBox(`${this.root.name}_${n}`, { width: w, height: h, depth: d }, this.scene);
    m.parent = parent;
    m.position.set(x, y, z);
    m.material = mat;
    this.meshes.push(m);
    return m;
  }

  private cyl(n: string, parent: TransformNode, mat: StandardMaterial, dia: number, h: number, x: number, y: number, z: number): Mesh {
    const m = MeshBuilder.CreateCylinder(`${this.root.name}_${n}`, { diameter: dia, height: h, tessellation: 8 }, this.scene);
    m.parent = parent;
    m.position.set(x, y, z);
    m.material = mat;
    this.meshes.push(m);
    return m;
  }

  private capsule(n: string, parent: TransformNode, mat: StandardMaterial, len: number, r: number, y: number): Mesh {
    const m = MeshBuilder.CreateCapsule(
      `${this.root.name}_${n}`,
      { height: len, radius: r, tessellation: 8, subdivisions: 1, capSubdivisions: 2 },
      this.scene,
    );
    m.parent = parent;
    m.position.y = y;
    m.material = mat;
    this.meshes.push(m);
    return m;
  }

  private leg(hip: TransformNode, pants: StandardMaterial, boots: StandardMaterial, s: string): TransformNode {
    this.capsule(`thigh${s}`, hip, pants, 0.5, 0.085, -0.225);
    const knee = this.node(`knee${s}`, hip, 0, -0.45, 0);
    this.capsule(`shin${s}`, knee, pants, 0.46, 0.065, -0.21);
    this.box(`boot${s}`, knee, boots, 0.12, 0.1, 0.27, 0, -0.43, 0.05);
    return knee;
  }

  private arm(sh: TransformNode, shirt: StandardMaterial, skin: StandardMaterial, s: string): TransformNode {
    this.capsule(`upper${s}`, sh, shirt, 0.32, 0.06, -0.14);
    const elbow = this.node(`elbow${s}`, sh, 0, -0.29, 0);
    this.capsule(`fore${s}`, elbow, skin, 0.28, 0.048, -0.13);
    const hand = MeshBuilder.CreateSphere(`${this.root.name}_hand${s}`, { diameter: 0.1, segments: 6 }, this.scene);
    hand.parent = elbow;
    hand.position.y = -0.28;
    hand.material = skin;
    this.meshes.push(hand);
    return elbow;
  }

  private makeGun(n: string, mat: StandardMaterial, len: number, thick: number): TransformNode {
    const g = this.node(`gun_${n}`, this.handR, 0, 0, 0);
    this.box(`gunBarrel_${n}`, g, mat, thick, len, thick * 1.4, 0, -len / 2 - 0.02, 0.03);
    this.box(`gunGrip_${n}`, g, mat, thick * 0.9, 0.05, 0.11, 0, -0.03, -0.02);
    return g;
  }

  private makeClanGun(accent: StandardMaterial, shirt: StandardMaterial, clan: ClanId): TransformNode {
    const g = this.node("gun_clan", this.handR, 0, 0, 0);
    // «Рука-дракон» / «рука-змея»: перчатка-голова с пастью и светящимся зарядом
    this.box("clanGlove", g, shirt, 0.13, 0.22, 0.13, 0, -0.1, 0.02);
    this.box("clanJaw", g, accent, 0.1, 0.12, 0.06, 0, -0.24, 0.07);
    const orb = MeshBuilder.CreateSphere(`${this.root.name}_clanOrb`, { diameter: 0.09, segments: 6 }, this.scene);
    orb.parent = g;
    orb.position.set(0, -0.27, 0.0);
    orb.material = flatMat(this.scene, clan === "dragons" ? "#ff8a1c" : "#7dff3a", 1);
    this.meshes.push(orb);
    return g;
  }

  setWeapon(id: WeaponId): void {
    for (const [k, g] of this.guns) g.setEnabled(k === id);
  }

  setVisible(v: boolean): void {
    for (const m of this.meshes) m.isVisible = v;
  }

  setEnabled(v: boolean): void {
    this.root.setEnabled(v);
  }

  /**
   * Процедурная анимация.
   * @param speed скорость движения, м/с
   * @param crouch присел ли
   * @param pitch наклон прицела (как у камеры: > 0 — вниз)
   * @param airborne в прыжке
   */
  animate(dt: number, speed: number, crouch: boolean, pitch: number, airborne: boolean): void {
    if (this.deathT > 0) {
      // Падение назад
      const t = Math.min(1, this.deathT);
      this.body.rotation.x = (-Math.PI / 2) * t * t;
      this.body.position.y = 0.12 * t;
      return;
    }
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    this.crouchT += ((crouch ? 1 : 0) - this.crouchT) * Math.min(1, dt * 12);
    const c = this.crouchT;
    const moving = speed > 0.3 && !airborne;
    this.phase += dt * (moving ? 2.2 + speed * 1.15 : 0);
    const amp = moving ? Math.min(1, speed / 6) * (1 - c * 0.5) : 0;
    const sw = Math.sin(this.phase);

    // Ноги
    const crouchHip = -1.25 * c;
    const crouchKnee = 1.55 * c;
    const airHip = airborne ? -0.5 : 0;
    const airKnee = airborne ? 0.9 : 0;
    this.hipL.rotation.x = crouchHip + airHip + sw * 0.75 * amp;
    this.hipR.rotation.x = crouchHip + airHip - sw * 0.75 * amp;
    this.kneeL.rotation.x = crouchKnee + airKnee + Math.max(0, -Math.cos(this.phase)) * 1.1 * amp;
    this.kneeR.rotation.x = crouchKnee + airKnee + Math.max(0, Math.cos(this.phase)) * 1.1 * amp;
    this.pelvis.position.y = 0.95 - 0.36 * c + Math.abs(Math.cos(this.phase)) * 0.04 * amp;

    // Корпус наклоняется при приседе и беге
    this.spine.rotation.x = 0.3 * c + amp * 0.12;
    // Голова следит за прицелом
    this.head.rotation.x = pitch * 0.5 - this.spine.rotation.x * 0.5;

    // Руки держат оружие перед собой
    const aim = pitch - Math.PI / 2 - this.spine.rotation.x;
    this.shoulderR.rotation.set(aim, 0, 0);
    this.elbowR.rotation.x = -0.1;
    this.shoulderL.rotation.set(aim + 0.25, 0.75, 0);
    this.elbowL.rotation.set(-0.5, 0, 0);
  }

  getMuzzlePosition(): Vector3 {
    return this.muzzle.getAbsolutePosition().clone();
  }

  dispose(): void {
    this.root.dispose(false, false);
  }
}
