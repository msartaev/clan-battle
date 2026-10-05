/**
 * Общие правила «Битвы кланов».
 * Этот пакет использует клиент (этап 0) и будет использовать сервер (этап 1),
 * чтобы числа урона, здоровья и патронов не расходились.
 */

export type ClanId = "dragons" | "snakes";

export interface ClanInfo {
  id: ClanId;
  name: string;
  /** Основной цвет клана, hex */
  color: string;
  /** Второй цвет (акцент), hex */
  accent: string;
  /** Название кланового оружия */
  weaponName: string;
  /** Визуальный эффект кланового оружия */
  effect: "fire" | "poison";
}

export const CLANS: Record<ClanId, ClanInfo> = {
  dragons: {
    id: "dragons",
    name: "Драконы",
    color: "#e8551c",
    accent: "#ffc23a",
    weaponName: "Рука-дракон",
    effect: "fire",
  },
  snakes: {
    id: "snakes",
    name: "Змеи",
    color: "#2f9e3a",
    accent: "#b6f04a",
    weaponName: "Рука-змея",
    effect: "poison",
  },
};

export function enemyClan(clan: ClanId): ClanId {
  return clan === "dragons" ? "snakes" : "dragons";
}

/** Правила матча (раздел GDD «Правила матча») */
export const RULES = {
  maxHp: 100,
  startAmmo: 50,
  lives: 3,
  playersPerClan: 10,
  matchSeconds: 30 * 60,
  friendlyFire: false,
  /** Через сколько секунд без урона начинается восстановление здоровья */
  regenDelaySec: 5,
  /** Сколько здоровья в секунду восстанавливается */
  regenPerSec: 1,
  /** Задержка возрождения игрока, сек */
  playerRespawnSec: 3,
  /** Задержка возрождения бота, сек */
  botRespawnSec: 5,
  /** Оранжевый сундук: патроны */
  chestAmmo: 25,
  /**
   * Через сколько секунд сундук появляется снова.
   * В GDD — 3 минуты; на маленькой карте прототипа ставим меньше.
   */
  chestRespawnSec: 45,
  /** Сколько патронов можно носить */
  maxAmmo: 150,
} as const;

export type WeaponId = "weakPistol" | "strongPistol" | "clanWeapon";

export interface WeaponDef {
  id: WeaponId;
  /** Название для интерфейса; для кланового оружия берётся из ClanInfo */
  name: string;
  /** Урон за попадание, из 100 здоровья */
  damage: number;
  /** Выстрелов в секунду */
  fireRate: number;
  /** Дальность, метры */
  range: number;
  /** Разброс, радианы */
  spread: number;
  /** Сколько патронов тратит выстрел */
  ammoPerShot: number;
}

/** Таблица оружия (раздел GDD «Оружие и урон»). Порядок = клавиши 1, 2, 3 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  weakPistol: {
    id: "weakPistol",
    name: "Слабый пистолет",
    damage: 5,
    fireRate: 6,
    range: 60,
    spread: 0.012,
    ammoPerShot: 1,
  },
  strongPistol: {
    id: "strongPistol",
    name: "Сильный пистолет",
    damage: 25,
    fireRate: 2,
    range: 80,
    spread: 0.006,
    ammoPerShot: 1,
  },
  clanWeapon: {
    id: "clanWeapon",
    name: "Клановое оружие",
    damage: 25,
    fireRate: 2.5,
    range: 40,
    spread: 0.02,
    ammoPerShot: 1,
  },
};

export const WEAPON_ORDER: WeaponId[] = ["weakPistol", "strongPistol", "clanWeapon"];

export function weaponDisplayName(id: WeaponId, clan: ClanId): string {
  return id === "clanWeapon" ? CLANS[clan].weaponName : WEAPONS[id].name;
}

/** Урон с учётом правила «по своим не бьём» */
export function computeDamage(weapon: WeaponId, shooterClan: ClanId, targetClan: ClanId): number {
  if (!RULES.friendlyFire && shooterClan === targetClan) return 0;
  return WEAPONS[weapon].damage;
}

/** Параметры движения персонажа, метры и секунды */
export const MOVEMENT = {
  walkSpeed: 4.2,
  sprintSpeed: 7.5,
  crouchSpeed: 2,
  jumpSpeed: 6.2,
  gravity: 18,
  standHeight: 1.8,
  crouchHeight: 1.15,
  eyeHeightStand: 1.65,
  eyeHeightCrouch: 1.0,
} as const;
