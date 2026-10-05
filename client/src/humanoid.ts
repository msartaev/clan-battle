import { Color3, Mesh, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { ClanId, WeaponId } from "@clan-battle/shared";
import { CLAN_SKINS, getModels, gunKey } from "./models";

/**
 * Блочный персонаж Kenney (в духе Майнкрафта), рост ~1.8 м.
 * Части тела жёсткие (ноги, руки, корпус, голова), анимация процедурная:
 * ходьба, присед, прицеливание и падение при смерти.
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
  /** Буква облика из Blocky Characters */
  skin: string;
}

export function randomLook(clan: ClanId, rnd: () => number = Math.random): HumanoidLook {
  const list = CLAN_SKINS[clan];
  return { clan, skin: list[Math.floor(rnd() * list.length)] };
}

/** Модель в своих единицах ~2.7 в высоту, приводим к росту 1.8 м */
const MODEL_SCALE = 0.66;

export class Humanoid {
  readonly root: TransformNode;
  /** Внутренний узел тела: на нём анимация падения, root двигает владелец */
  readonly body: TransformNode;
  /** Точка вылета пули (кончик ствола) */
  readonly muzzle: TransformNode;
  readonly meshes: Mesh[] = [];
  private model: TransformNode;
  private torso: TransformNode;
  private head: TransformNode;
  private legL: TransformNode;
  private legR: TransformNode;
  private armL: TransformNode;
  private armR: TransformNode;
  private guns = new Map<WeaponId, TransformNode>();
  private muzzles = new Map<WeaponId, TransformNode>();
  private weapon: WeaponId = "weakPistol";
  private phase = 0;
  private crouchT = 0;
  /** 0..1 — падение при смерти */
  deathT = 0;

  constructor(scene: Scene, name: string, look: HumanoidLook) {
    const models = getModels();
    this.root = new TransformNode(`${name}_root`, scene);
    this.body = new TransformNode(`${name}_body`, scene);
    this.body.parent = this.root;

    const inst = models.character.instantiateModelsToScene((n) => `${name}_${n}`, false, { doNotInstantiate: true });
    for (const g of inst.animationGroups) g.dispose();
    this.model = inst.rootNodes[0] as TransformNode;
    this.model.parent = this.body;
    // __root__ из glTF уже перевёрнут под левую систему координат — масштабируем, сохраняя знаки
    this.model.scaling.scaleInPlace(MODEL_SCALE);

    const mat = models.skinMat(look.skin);
    const find = (part: string) => {
      const n = this.model.getDescendants(false).find((d) => d.name === `${name}_${part}`) as TransformNode;
      if (!n) throw new Error(`В модели нет части ${part}`);
      n.rotationQuaternion = null;
      return n;
    };
    this.torso = find("torso");
    this.head = find("head");
    this.legL = find("leg-left");
    this.legR = find("leg-right");
    this.armL = find("arm-left");
    this.armR = find("arm-right");
    for (const m of this.model.getChildMeshes(false)) {
      m.material = mat;
      this.meshes.push(m as Mesh);
    }

    // Бластеры в правой руке. Рука висит вдоль -Y, ствол бластера смотрит вдоль +Z
    const weapons: WeaponId[] = ["weakPistol", "strongPistol", "clanWeapon"];
    for (const w of weapons) {
      const gi = models.guns[gunKey(w, look.clan)].instantiateModelsToScene((n) => `${name}_${w}_${n}`, false, {
        doNotInstantiate: true,
      });
      const holder = new TransformNode(`${name}_gun_${w}`, scene);
      holder.parent = this.armR;
      holder.position.set(-0.2, -0.85, 0.15);
      holder.rotation.x = Math.PI / 2;
      const g = gi.rootNodes[0] as TransformNode;
      g.parent = holder;
      g.scaling.scaleInPlace(w === "clanWeapon" ? 0.9 : 0.75);
      for (const m of g.getChildMeshes(false)) {
        m.material = models.gunMat;
        this.meshes.push(m as Mesh);
      }
      const muzzle = new TransformNode(`${name}_muzzle_${w}`, scene);
      muzzle.parent = holder;
      muzzle.position.set(0, 0.05, w === "clanWeapon" ? 0.7 : 0.45);
      this.guns.set(w, holder);
      this.muzzles.set(w, muzzle);
    }
    this.muzzle = this.muzzles.get("weakPistol")!;
    this.setWeapon("weakPistol");

    for (const m of this.meshes) {
      // Персонажи двигаются, поэтому рамку для отсечения пересчитываем каждый кадр:
      // с doNotSyncBoundingInfo тело пропадало, стоило отойти от точки появления
      m.isPickable = false;
    }
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
      this.body.position.y = 0.15 * t;
      return;
    }
    this.body.rotation.x = 0;
    this.crouchT += ((crouch ? 1 : 0) - this.crouchT) * Math.min(1, dt * 12);
    const c = this.crouchT;
    const moving = speed > 0.3 && !airborne;
    this.phase += dt * (moving ? 2.2 + speed * 1.15 : 0);
    const amp = moving ? Math.min(1, speed / 6) * (1 - c * 0.6) : 0;
    const sw = Math.sin(this.phase);

    // Ноги: шаг, в прыжке поджаты, в приседе выставлены вперёд (как на корточках)
    const legBase = airborne ? -0.5 : -1.1 * c;
    this.legL.rotation.x = legBase + sw * 0.8 * amp;
    this.legR.rotation.x = (airborne ? 0.3 : legBase) - sw * 0.8 * amp;
    // Опускаем тело при приседе, чтобы голова оказалась на уровне укрытия
    this.body.position.y = -0.42 * c + Math.abs(Math.cos(this.phase)) * 0.04 * amp;

    // Корпус наклоняется при беге
    this.torso.rotation.x = amp * 0.15 + c * 0.15;
    // Голова следит за прицелом
    this.head.rotation.x = pitch * 0.5 - this.torso.rotation.x;

    // Правая рука держит оружие по линии прицела, левая поддерживает
    const aim = -Math.PI / 2 + pitch - this.torso.rotation.x;
    this.armR.rotation.set(aim, 0, 0);
    this.armL.rotation.set(aim + 0.15, 0, -0.5);
  }

  getMuzzlePosition(): Vector3 {
    return (this.muzzles.get(this.weapon) ?? this.muzzle).getAbsolutePosition().clone();
  }

  dispose(): void {
    this.root.dispose(false, false);
  }
}
