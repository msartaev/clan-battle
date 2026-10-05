import { AssetContainer, LoadAssetContainerAsync, Scene, StandardMaterial, Texture } from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";
import type { ClanId, WeaponId } from "@clan-battle/shared";

/**
 * Готовые модели Kenney (CC0): блочные персонажи и бластеры.
 * Грузятся один раз до сборки сцены, дальше Humanoid их только клонирует.
 */

/** Облики персонажей (буква = texture-X.png из Blocky Characters) по кланам */
export const CLAN_SKINS: Record<ClanId, string[]> = {
  dragons: ["b", "k", "g", "d", "p"],
  snakes: ["c", "m", "f", "n", "o", "l"],
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

export interface Models {
  character: AssetContainer;
  guns: Record<GunKey, AssetContainer>;
  /** Материал персонажа по букве облика */
  skinMat(letter: string): StandardMaterial;
  /** Общий материал бластеров (одна палитра на всех) */
  gunMat: StandardMaterial;
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
  const [character, ...gunList] = await Promise.all([
    load("blocky/character.glb"),
    ...Object.values(GUN_FILES).map((f) => load(`blasters/${f}.glb`)),
  ]);
  const guns = Object.fromEntries(Object.keys(GUN_FILES).map((k, i) => [k, gunList[i]])) as Record<GunKey, AssetContainer>;

  // glTF даёт PBR-материалы; на телефонах простой StandardMaterial заметно дешевле
  for (const c of [character, ...gunList]) {
    for (const m of c.materials) m.dispose(true, true);
    c.materials.length = 0;
    c.textures.length = 0;
    for (const g of c.animationGroups) g.dispose();
    c.animationGroups.length = 0;
  }

  const skinMats = new Map<string, StandardMaterial>();
  const gunMat = new StandardMaterial("gunMat", scene);
  gunMat.diffuseTexture = paletteTexture(`${BASE}blasters/Textures/colormap.png`, scene);
  gunMat.specularColor.set(0.08, 0.08, 0.08);

  models = {
    character,
    guns,
    gunMat,
    skinMat(letter) {
      let m = skinMats.get(letter);
      if (!m) {
        m = new StandardMaterial(`skin_${letter}`, scene);
        m.diffuseTexture = paletteTexture(`${BASE}blocky/Textures/texture-${letter}.png`, scene);
        m.specularColor.set(0.04, 0.04, 0.04);
        skinMats.set(letter, m);
      }
      return m;
    },
  };
  return models;
}
