import {
  AssetContainer,
  Color3,
  LoadAssetContainerAsync,
  Mesh,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";
import type { ClanId, WeaponId } from "@clan-battle/shared";

/**
 * Готовые модели Kenney (CC0): блочные персонажи и бластеры.
 * Грузятся один раз до сборки сцены, дальше Humanoid их только клонирует.
 */

/** Природа из Kenney Nature Kit: деревья, кусты, камни и мелкие детали */
export const NATURE = [
  "stone_largeA",
  "stone_largeC",
  "stone_tallB",
  "stump_round",
  "log",
  "flower_redA",
  "flower_yellowA",
  "flower_purpleA",
  "grass_large",
  "grass_leafsLarge",
  "mushroom_redGroup",
] as const;
export type NatureId = (typeof NATURE)[number];

/** Цвета набора слишком пастельные и бирюзовые — перекрашиваем в палитру нашей карты */
const NATURE_COLORS: Record<string, string> = {
  leafsGreen: "#4f9a3a",
  leafsDark: "#2f6b3a",
  woodBark: "#6b4a2b",
  woodBarkDark: "#5a3d24",
  woodInner: "#d9b98c",
  grass: "#4a8c35",
  stone: "#8d9399",
  dirt: "#7a5a3a",
  colorRed: "#d8433c",
  colorYellow: "#f2c94c",
  colorPurple: "#9b6bd6",
  _defaultMat: "#efe9dc",
};

/** Какой бластер у какого оружия; клановое зависит от клана */
const GUN_FILES = {
  weakPistol: "blaster-a",
  strongPistol: "blaster-k",
  clan_dragons: "blaster-c",
  clan_snakes: "blaster-o",
} as const;
type GunKey = keyof typeof GUN_FILES;

export function gunKey(weapon: WeaponId, clan: ClanId): GunKey {
  return weapon === "clanWeapon" ? `clan_${clan}` : weapon;
}

/** Люди Quaternius Ultimate Modular (CC0): одетые, на общем скелете, с клипами Idle/Walk/Run */
export const BODIES = ["casual_hoodie", "casual_2", "worker", "w_casual", "beach", "w_formal"] as const;
export type BodyId = (typeof BODIES)[number];

export interface Models {
  humans: Record<BodyId, AssetContainer>;
  /** Плоский материал части тела; цвет из модели или подменённый (одежда в цвет клана) */
  humanMat(body: BodyId, part: string, color?: string): StandardMaterial;
  guns: Record<GunKey, AssetContainer>;
  /** Общий материал бластеров (одна палитра на всех) */
  gunMat: StandardMaterial;
  /**
   * Скрытая базовая сетка модели природы (все части слиты в одну с мульти-материалом):
   * от неё делают createInstance, высота приведена к 1 м
   */
  nature(id: NatureId): Mesh;
}

let models: Models | null = null;

export function getModels(): Models {
  if (!models) throw new Error("Модели ещё не загружены");
  return models;
}

const BASE = "./models/";

/** Пиксельная палитра: без сглаживания, чтобы цвета не смешивались на стыках */
function paletteTexture(url: string, scene: Scene): Texture {
  const t = new Texture(url, scene, true, false, Texture.NEAREST_SAMPLINGMODE);
  return t;
}

export async function loadModels(scene: Scene): Promise<Models> {
  const load = (path: string) => LoadAssetContainerAsync(BASE + path, scene);
  const [...rest0] = await Promise.all([
    ...BODIES.map((b) => load(`humans/${b}.glb`)),
    ...Object.values(GUN_FILES).map((f) => load(`blasters/${f}.glb`)),
    ...NATURE.map((n) => load(`nature/${n}.glb`)),
  ]);
  const humanList = rest0.slice(0, BODIES.length);
  const rest = rest0.slice(BODIES.length);
  const gunList = rest.slice(0, Object.keys(GUN_FILES).length);
  const natureList = rest.slice(gunList.length);
  const guns = Object.fromEntries(Object.keys(GUN_FILES).map((k, i) => [k, gunList[i]])) as Record<GunKey, AssetContainer>;

  // glTF даёт PBR-материалы; на телефонах простой StandardMaterial заметно дешевле
  // Цвета людей берём из их PBR-материалов (текстур у них нет), сами материалы не трогаем
  const humanColor = new Map<string, Color3>();
  BODIES.forEach((body, i) => {
    for (const m of humanList[i].materials) humanColor.set(`${body}|${m.name}`, (m as PBRMaterial).albedoColor.toGammaSpace());
  });
  for (const c of [...gunList, ...natureList]) {
    // Имена материалов природы нужны для перекраски — у неё их не трогаем
    if (natureList.includes(c)) {
      for (const g of c.animationGroups) g.dispose();
      continue;
    }
    for (const m of c.materials) m.dispose(true, true);
    c.materials.length = 0;
    c.textures.length = 0;
    for (const g of c.animationGroups) g.dispose();
    c.animationGroups.length = 0;
  }

  const gunMat = new StandardMaterial("gunMat", scene);
  gunMat.diffuseTexture = paletteTexture(`${BASE}blasters/Textures/colormap.png`, scene);
  gunMat.specularColor.set(0.08, 0.08, 0.08);

  const natureMats = new Map<string, StandardMaterial>();
  const natureMat = (name: string) => {
    let m = natureMats.get(name);
    if (!m) {
      m = new StandardMaterial(`nature_${name}`, scene);
      m.diffuseColor = Color3.FromHexString(NATURE_COLORS[name] ?? "#7f7f7f");
      m.specularColor.set(0.03, 0.03, 0.03);
      natureMats.set(name, m);
    }
    return m;
  };
  const natureBases = new Map<NatureId, Mesh>();

  const humanMats = new Map<string, StandardMaterial>();

  models = {
    humans: Object.fromEntries(BODIES.map((b, i) => [b, humanList[i]])) as Record<BodyId, AssetContainer>,
    humanMat(body, part, color) {
      const key = `${body}|${part}|${color ?? ""}`;
      let m = humanMats.get(key);
      if (!m) {
        // StandardMaterial дешевле PBR на телефонах; цвет — из модели или цвет клана
        m = new StandardMaterial(`human_${key}`, scene);
        m.diffuseColor = color ? Color3.FromHexString(color) : (humanColor.get(`${body}|${part}`) ?? new Color3(0.7, 0.7, 0.7));
        m.specularColor.set(0.05, 0.05, 0.05);
        humanMats.set(key, m);
      }
      return m;
    },
    nature(id) {
      let base = natureBases.get(id);
      if (base) return base;
      const c = natureList[NATURE.indexOf(id)];
      const inst = c.instantiateModelsToScene((n) => `nat_${id}_${n}`, false, { doNotInstantiate: true });
      const root = inst.rootNodes[0] as TransformNode;
      const parts = root.getChildMeshes(false).filter((m) => m.getTotalVertices() > 0) as Mesh[];
      for (const p of parts) p.material = natureMat(p.material?.name ?? "_defaultMat");
      // Сливаем части в одну сетку: тогда тысячи экземпляров рисуются парой вызовов
      base = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
      root.dispose();
      base.name = `nature_${id}`;
      // Приводим к высоте 1 м и ставим основание на землю
      base.refreshBoundingInfo();
      const bb = base.getBoundingInfo().boundingBox;
      const h = bb.maximumWorld.y - bb.minimumWorld.y || 1;
      base.scaling.setAll(1 / h);
      base.position.y = -bb.minimumWorld.y / h;
      base.bakeCurrentTransformIntoVertices();
      base.isVisible = false;
      base.isPickable = false;
      natureBases.set(id, base);
      return base;
    },
    guns,
    gunMat,
  };
  return models;
}
