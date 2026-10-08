import {
  DynamicTexture,
  ParticleSystem,
  PhotoDome,
  StandardMaterial,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  InstancedMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  Ray,
  Scene,
  ShadowGenerator,
  TransformNode,
  Vector3,
  type AbstractMesh,
} from "@babylonjs/core";
import {
  CLANS,
  MELEE,
  RULES,
  STICKY,
  WEAPON_ORDER,
  SWORDS,
  WEAPONS,
  computeDamage,
  enemyClan,
  type ClanId,
  type WeaponId,
} from "@clan-battle/shared";
import { Animal, type Prey } from "./animals";
import { Humanoid } from "./humanoid";
import { FallingLeaves } from "./leaves";
import { Race, RACE_LAPS, RACE_OFFROAD_SPEED, RACE_TOP_SPEED } from "./race";
import { Birds } from "./birds";
import { Drone, type DroneTarget } from "./drones";
import { Bot, type BotContext, type Target } from "./bot";
import { Effects, Sfx } from "./effects";
import { Hud } from "./hud";
import { flatMat } from "./humanoid";
import { getModels, gunKey, loadModels, slingshotMesh, swordMesh } from "./models";
import type { Input } from "./input";
import { Player } from "./player";
import { applySpread, clamp, dirFromYawPitch, makeRng, rayVsVerticalSegment } from "./utils";
import { MAP_HALF, type WindowPane, World } from "./world";

export interface GameOptions {
  clan: ClanId;
  touch: boolean;
  /** Слабое устройство: без теней, меньше частиц, ниже разрешение */
  lowFx: boolean;
  /** Уровень (карта): 1 — деревня, 2 — большая карта с биомами */
  level?: number;
  /** Детализация мира: 1 — «Красиво», 0.35 — «Средне», 0.15 — «Быстро» */
  detail: number;
  /** Режим автотестов: без паузы при потере курсора */
  testMode: boolean;
  botCount: number;
}

type GameState = "playing" | "dead" | "over";

interface AmmoChest {
  mesh: InstancedMesh;
  pos: Vector3;
  active: boolean;
  respawnAt: number;
}

/** Итог матча для экрана конца игры */
export interface MatchResult {
  /** Победивший клан; null — ничья или игрок выбыл раньше конца */
  winner: ClanId | null;
  /** Почему закончилось — для текста на экране */
  reason: string;
  /** Победил ли клан игрока */
  won: boolean;
  kills: number;
}

interface Capture {
  /** Кто сейчас захватывает этот флаг */
  by: Target | null;
  t: number;
  startedAt: number;
}

const BOT_WEAPONS: WeaponId[] = ["weakPistol", "weakPistol", "strongPistol", "weakPistol", "clanWeapon", "weakPistol", "strongPistol", "clanWeapon"];

const isWorld = (m: AbstractMesh) => m.metadata?.kind === "world";
/** Пулям мешают стены и целые стёкла (стекло при этом бьётся) */
const isSolid = (m: AbstractMesh) => m.metadata?.kind === "world" || m.metadata?.kind === "glass";
const isWorldOrSoft = (m: AbstractMesh) => m.metadata?.kind === "world" || m.metadata?.kind === "soft";

/** Обычный угол обзора камеры, рад */
const BASE_FOV = 1.05;

type InvItem = "spikes" | "guard" | "fenceWeak" | "fenceStrong";
type ShopItem = InvItem | "weak";
interface Fence {
  root: Mesh;
  box: Mesh;
  pos: Vector3;
  yaw: number;
  hp: number;
  zap: number;
  clan: ClanId;
  hitAt: Map<object, number>;
  kind: "fenceWeak" | "fenceStrong";
}
/** Электрозаборы (Даниэль): слабый бьёт током на 10, сильный — на 20 */
const FENCE = {
  fenceWeak: { name: "Слабый электрозабор", icon: "⚡", zap: 10, hp: 10, wood: 6, leather: 1 },
  fenceStrong: { name: "Сильный электрозабор", icon: "⚡⚡", zap: 20, hp: 20, wood: 20, leather: 4 },
} as const;

export class Game {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  world!: World;
  player!: Player;
  readonly bots: Bot[] = [];
  effects!: Effects;
  readonly sfx = new Sfx();
  hud!: Hud;
  firstPerson = false;
  now = 0;
  kills = 0;
  state: GameState = "playing";
  paused = false;
  private nextShotAt = 0;
  private prevFire = false;
  private deadTimer = 0;
  private viewmodel!: TransformNode;
  private vmGuns = new Map<WeaponId, TransformNode>();
  private vmMuzzle!: TransformNode;
  private vmKick = 0;
  private chests: AmmoChest[] = [];
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fpsShown = 0;
  private camDist = 3.6;
  /** Смотрим в подзорную трубу (Драконы) или бинокль (Змеи) */
  scoped = false;
  private aiming = false;
  /** Игрок как цель для вражеских ботов */
  private playerTarget!: Target;
  private botTargets = new Map<Bot, Target>();
  private rng = makeRng(7);
  private emptyWarnAt = 0;
  onGameOver: (r: MatchResult) => void = () => undefined;
  /** Осталось секунд до конца матча */
  matchLeft: number = RULES.protoMatchSeconds;
  teamKills: Record<ClanId, number> = { dragons: 0, snakes: 0 };
  /** Захват флага; ключ — чей это флаг */
  capture: Record<ClanId, Capture> = {
    dragons: { by: null, t: 0, startedAt: 0 },
    snakes: { by: null, t: 0, startedAt: 0 },
  };
  private medkits: AmmoChest[] = [];
  readonly animals: Animal[] = [];
  private birds!: Birds;
  /** Дроны леса (уровень 2) */
  readonly drones: Drone[] = [];
  /** Уровень 4: каждый сам за себя — враги все, кроме тебя самого */
  get ffa(): boolean {
    return this.world.level === 4;
  }

  /** Бот — враг игрока? (в «каждый сам за себя» — все) */
  private foeOfPlayer(b: Bot): boolean {
    return this.ffa || b.clan !== this.player.clan;
  }

  /** Насколько игрок провалился в сугроб: 0..1, на 1 — замёрз */
  private sink = 0;

  /** Сугробы: вязнешь, проваливаешься, за 5 секунд в глубине — замёрз (−1 жизнь) */
  private updateSnow(dt: number): void {
    if (!this.ffa) return;
    const p = this.player;
    if (!p.alive || this.state !== "playing") {
      this.sink = 0;
      return;
    }
    const depth = this.world.driftDepth(p.position.x, p.position.z);
    p.speedMul = depth > 0.15 ? 0.45 : 1;
    if (depth > 0.15) {
      this.sink = Math.min(1, this.sink + (dt / 5) * (0.5 + depth));
      if (this.sink > 0.25 && Math.random() < dt) this.hud.message("Проваливаешься в снег! Выбирайся!", 1, "#9fe8ff");
    } else {
      this.sink = Math.max(0, this.sink - dt / 2);
    }
    // Тело уходит в снег — видно со стороны и по высоте камеры
    p.humanoid.body.position.y = -1.1 * this.sink;
    if (this.sink >= 1) {
      this.sink = 0;
      this.hud.message("Замёрз в сугробе! −1 жизнь", 2, "#9fe8ff");
      p.invulnerableUntil = 0;
      this.damagePlayer(9999);
    }
  }

  /** Ресурсы для торговца: дерево (рубить мечом) и кожа (со зверей) */
  res = { wood: 0, leather: 0 };
  /** Торговец: приходит к бункеру раз в минуту на 30 с */
  private trader: Humanoid | null = null;
  private traderUntil = -1;
  private nextTraderAt = 60;
  private shopOpen = false;
  /** Сколько охранников клан уже купил (цена растёт) */
  private guardsBought: Record<ClanId, number> = { dragons: 0, snakes: 0 };
  private spikes: { mesh: Mesh; pos: Vector3; uses: number; clan: ClanId; hitAt: Map<object, number> }[] = [];
  /** Инвентарь базы: купленное у торговца ставится руками куда хочешь (идея Даниэля) */
  inv: Record<InvItem, number> = { spikes: 0, guard: 0, fenceWeak: 0, fenceStrong: 0 };
  /** Что сейчас ставим (призрак перед игроком) */
  building: InvItem | null = null;
  private ghost: Mesh | null = null;
  fences: Fence[] = [];
  private leaves: FallingLeaves | null = null;
  /** Уровень 5: гонка */
  race: Race | null = null;
  /** За рулём какой машины (или null) */
  driving: { mesh: Mesh; yaw: number; home: Vector3; homeYaw: number; speed?: number } | null = null;
  private carSpeed = 0;
  private ramCooldown = new Map<object, number>();
  /** Замах мечом: когда начали держать кнопку (или -1) */
  private chargeFrom = -1;
  /** Держим меч ровно, как щит */
  blocking = false;
  /** Снаряжение, выбранное перед матчем */
  private loadout: { weapons: WeaponId[]; bombs: ("weak" | "boom" | "frost")[] } = {
    weapons: ["weakPistol", "strongPistol", "clanWeapon", "sword", "sticky"],
    bombs: ["weak", "boom", "frost"],
  };

  setLoadout(weapons: WeaponId[], bombs: ("weak" | "boom" | "frost")[]): void {
    this.loadout = { weapons: [...weapons], bombs: [...bombs] };
  }

  /** Лечебные бомбы в запасе */
  bombs = { weak: 1, strong: 0, boom: 1, frost: 1 };
  /** Летящие боевые бомбы */
  private thrown: { mesh: Mesh; pos: Vector3; vel: Vector3; kind: "boom" | "frost"; clan: ClanId }[] = [];
  /** Игрока заморозили вражеской бомбой */
  private playerFrozenUntil = -1;
  /** Ледяные глыбы вокруг замороженных */
  private ice: { mesh: Mesh; until: number; follow: Vector3; y?: number }[] = [];
  /** Активный купол бессмертия (один на игрока) */
  dome: { mesh: Mesh; center: Vector3; until: number; total: number } | null = null;
  private playerPrey!: Prey;
  private botPrey = new Map<Bot, Prey>();
  private animalTargets = new Map<Animal, Target>();
  onDeath: (livesLeft: number) => void = () => undefined;
  onRespawn: () => void = () => undefined;

  constructor(
    canvas: HTMLCanvasElement,
    readonly input: Input,
    readonly opts: GameOptions,
  ) {
    this.engine = new Engine(canvas, !opts.lowFx, {
      preserveDrawingBuffer: opts.testMode,
      stencil: false,
      powerPreference: "high-performance",
      antialias: !opts.lowFx,
    }, false);
    // На телефоне рисуем в пониженном разрешении — это главный выигрыш в FPS
    const dpr = window.devicePixelRatio || 1;
    // «Быстро» рисует ещё в 1.4 раза меньше пикселей
    const fast = opts.detail < 0.3 ? 1.4 : 1;
    this.engine.setHardwareScalingLevel((opts.touch ? Math.max(1, dpr / 1.25) * 1.15 : 1) * fast);

    const scene = new Scene(this.engine);
    this.scene = scene;
    scene.clearColor = new Color4(0.62, 0.79, 0.95, 1);
    scene.ambientColor = new Color3(0.3, 0.3, 0.3);
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogColor = new Color3(0.68, 0.82, 0.95);
    scene.fogStart = opts.touch ? 45 : 70;
    scene.fogEnd = opts.touch ? 110 : 160;
    scene.collisionsEnabled = true;
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;

    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.75;
    hemi.groundColor = new Color3(0.35, 0.4, 0.3);
    const sun = new DirectionalLight("sun", new Vector3(-0.45, -1, -0.3), scene);
    sun.position = new Vector3(60, 120, 40);
    sun.intensity = 0.85;
    sun.diffuse = new Color3(1, 0.96, 0.88);

    this.camera = new FreeCamera("cam", new Vector3(0, 2, -5), scene);
    this.camera.minZ = 0.05;
    this.camera.maxZ = opts.touch ? 130 : 200;
    this.camera.fov = BASE_FOV;
    this.camera.inputs.clear();
    scene.activeCamera = this.camera;
    this.sun = sun;

    // Небо: панорама с облаками (Poly Haven, CC0). Купол меньше дальности камеры и без тумана
    const sky = new PhotoDome("sky", "./textures/sky.jpg", { resolution: 24, size: opts.touch ? 220 : 340 }, scene);
    sky.material.fogEnabled = false;
    sky.mesh.applyFog = false;
    // Купол всегда вокруг камеры: иначе на краю карты дальняя стенка выходит за дальность камеры
    sky.infiniteDistance = true;
    sky.mesh.isPickable = false;
    // Туман и фон под цвет горизонта панорамы, чтобы дальние деревья растворялись в небе
    scene.fogColor = new Color3(0.78, 0.84, 0.92);
    scene.clearColor = new Color4(0.78, 0.84, 0.92, 1);
  }

  /** Сборка игры: сначала грузим модели персонажей и оружия, потом строим мир */
  static async create(canvas: HTMLCanvasElement, input: Input, opts: GameOptions): Promise<Game> {
    const g = new Game(canvas, input, opts);
    await loadModels(g.scene);
    g.buildScene();
    return g;
  }

  private sun!: DirectionalLight;

  private buildScene(): void {
    const { scene, opts, sun } = this;
    // На телефонах и в режиме ?low мелких деталей (трава, цветы) втрое меньше
    this.world = new World(scene, opts.detail, opts.level ?? 1);
    this.effects = new Effects(scene, opts.lowFx || opts.touch);
    this.player = new Player(scene, opts.clan);
    this.hud = new Hud(opts.clan);
    this.hud.onSlotTap((i) => this.player.selectWeapon(i));

    // Команды 5 на 5: сначала враги (botCount), потом союзники — на одного меньше, ведь игрок тоже в команде
    const enemy = enemyClan(opts.clan);
    const lvl = opts.level ?? 1;
    if (lvl === 5) {
      // Гонки: соперники — машины (race.ts), людей-ботов нет
    } else if (lvl === 4) {
      // Снег: трое соперников, у каждого своё — клановое оружие или рогатка
      const ffaWeapons: WeaponId[] = ["clanWeapon", "slingshot", "clanWeapon"];
      for (let i = 0; i < 3; i++) this.bots.push(new Bot(scene, i % 2 ? opts.clan : enemy, ffaWeapons[i]));
    } else {
      const enemies = lvl === 3 ? Math.min(4, opts.botCount) : opts.botCount;
      for (let i = 0; i < enemies; i++) {
        this.bots.push(new Bot(scene, enemy, BOT_WEAPONS[i % BOT_WEAPONS.length]));
      }
    }
    // Уровень 3 — соло: союзников нет
    const allies = (opts.level ?? 1) >= 3 ? 0 : opts.botCount - 1;
    if (lvl === 5) {
      const game = this;
      this.race = new Race(
        {
          scene,
          effects: this.effects,
          sfx: this.sfx,
          now: () => game.now,
          playerCar: () => ({ pos: game.player.position, yaw: game.player.yaw, alive: game.player.alive && game.state === "playing" }),
          damagePlayer: (d) => game.damagePlayer(d),
          message: (t, sec, c) => game.hud.message(t, sec, c),
          clearLine: (a, b) => {
            const d = b.subtract(a);
            const len = d.length();
            const hit = game.scene.pickWithRay(new Ray(a, d.scale(1 / len), len), (m) => isWorld(m) && !Race.racerOf(m) && !game.world.cars.some((c) => c.mesh === m), true);
            return !hit?.hit;
          },
        },
        this.world.track!,
      );
    }
    for (let i = 0; i < allies; i++) {
      this.bots.push(new Bot(scene, opts.clan, BOT_WEAPONS[(i + 1) % BOT_WEAPONS.length], true));
    }
    // В каждой команде двое штурмовиков: в свободное время идут за вражеским флагом
    for (const c of ["dragons", "snakes"] as const) {
      this.bots.filter((b) => b.clan === c).slice(1, 3).forEach((b) => (b.attacker = true));
    }
    const p = this.player;
    const game = this;
    this.playerTarget = {
      pos: p.position,
      get alive() {
        return p.alive && game.state === "playing";
      },
      clan: opts.clan,
      bot: null,
    };

    // Вид от первого лица: руки с оружием прикреплены к камере
    this.viewmodel = new TransformNode("viewmodel", scene);
    this.viewmodel.parent = this.camera;
    this.vmMuzzle = this.buildViewmodel();

    this.buildChests();
    this.buildMedkits();
    this.spawnAnimals();
    this.birds = new Birds(this.scene, this.world.level === 4 ? 0 : opts.detail < 1 ? 6 : 12);
    if (this.world.level === 4) this.makeSnowfall(opts.detail);
    else if (!opts.lowFx || opts.detail >= 1) this.leaves = new FallingLeaves(this.scene);
    if (this.world.level === 2) {
      const ground = (x: number, z: number) => this.world.heightAt(x, z);
      for (let i = 0; i < (opts.detail < 0.3 ? 2 : 3); i++) this.drones.push(new Drone(this.scene, { x0: 15, z0: 15, x1: 95, z1: 95 }, ground));
    }

    if (!opts.touch && !opts.lowFx) {
      const sg = new ShadowGenerator(2048, sun);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = ShadowGenerator.QUALITY_LOW;
      sg.bias = 0.0015;
      sg.normalBias = 0.02;
      for (const m of this.world.shadowCasters) if (m instanceof Mesh) sg.addShadowCaster(m, false);
      for (const m of this.player.humanoid.meshes) sg.addShadowCaster(m, false);
      for (const b of this.bots) for (const m of b.humanoid.meshes) sg.addShadowCaster(m, false);
    }
    sun.autoUpdateExtends = false;
    sun.shadowMinZ = 1;
    sun.shadowMaxZ = 260;
    sun.orthoLeft = -80;
    sun.orthoRight = 80;
    sun.orthoTop = 80;
    sun.orthoBottom = -80;

    this.resetMatch();

    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener("resize", this.onResize);
  }

  private onResize = () => this.engine.resize();

  private buildViewmodel(): TransformNode {
    const clan = CLANS[this.opts.clan];
    const vm = this.viewmodel;
    vm.position.set(0.22, -0.2, 0.42);
    const sleeve = MeshBuilder.CreateBox("vmSleeve", { width: 0.09, height: 0.09, depth: 0.32 }, this.scene);
    sleeve.material = flatMat(this.scene, clan.color);
    sleeve.parent = vm;
    sleeve.position.set(0.03, -0.04, -0.2);
    const hand = MeshBuilder.CreateBox("vmHand", { width: 0.08, height: 0.09, depth: 0.1 }, this.scene);
    hand.material = flatMat(this.scene, "#e0ac84");
    hand.parent = vm;
    hand.position.set(0, -0.02, -0.02);
    const mk = (id: WeaponId, build: (g: TransformNode) => void) => {
      const g = new TransformNode(`vm_${id}`, this.scene);
      g.parent = vm;
      build(g);
      this.vmGuns.set(id, g);
    };
    // Те же бластеры Kenney, что и у персонажей; ствол смотрит вдоль +Z камеры
    const models = getModels();
    const vmGun = (id: WeaponId, scale: number) =>
      mk(id, (g) => {
        const key = gunKey(id, this.opts.clan);
        if (id === "sword") {
          SWORDS[this.opts.clan].slice(0, 2).forEach((sw, lvl) => {
            const m = swordMesh(this.scene, `vmSword${lvl + 1}`, this.opts.clan, sw.length);
            m.parent = g;
            m.position.set(0, -0.02, 0.0);
            m.setEnabled(lvl === 0);
            this.vmSwords.push(m);
          });
          return;
        }
        if (!key) {
          const sl = slingshotMesh(this.scene, "vmSling");
          sl.parent = g;
          sl.scaling.setAll(1.3);
          sl.position.set(0, 0.0, 0.08);
          return;
        }
        const gi = models.guns[key].instantiateModelsToScene((n) => `vm_${id}_${n}`, false, {
          doNotInstantiate: true,
        });
        const r = gi.rootNodes[0] as TransformNode;
        r.parent = g;
        r.scaling.scaleInPlace(scale);
        r.position.set(0, 0.02, 0.1);
        for (const m of r.getChildMeshes(false)) m.material = models.gunMat;
      });
    vmGun("weakPistol", 0.32);
    vmGun("strongPistol", 0.36);
    vmGun("clanWeapon", 0.42);
    vmGun("slingshot", 1);
    vmGun("sword", 1);
    vmGun("sticky", 0.34);
    const muzzle = new TransformNode("vmMuzzle", this.scene);
    muzzle.parent = vm;
    muzzle.position.set(0, 0.04, 0.3);
    for (const m of vm.getChildMeshes()) {
      m.renderingGroupId = 1;
      m.isPickable = false;
    }
    vm.setEnabled(false);
    return muzzle;
  }

  private buildChests(): void {
    const base = MeshBuilder.CreateBox("chestBase", { width: 0.9, height: 0.55, depth: 0.6 }, this.scene);
    const lid = MeshBuilder.CreateBox("chestLid", { width: 0.94, height: 0.14, depth: 0.64 }, this.scene);
    lid.position.y = 0.32;
    const band = MeshBuilder.CreateBox("chestBand", { width: 0.12, height: 0.6, depth: 0.62 }, this.scene);
    base.material = flatMat(this.scene, "#ff8c1a", 0.25);
    lid.material = flatMat(this.scene, "#e06a00", 0.2);
    band.material = flatMat(this.scene, "#5a3a1a");
    const chest = Mesh.MergeMeshes([base, lid, band], true, true, undefined, false, true)!;
    chest.name = "ammoChest";
    chest.isVisible = false;
    chest.isPickable = false;
    this.world.ammoSpots.forEach((p, i) => {
      const inst = chest.createInstance(`chest${i}`);
      inst.position.set(p.x, p.y + 0.3, p.z);
      inst.isPickable = false;
      this.chests.push({ mesh: inst, pos: p.clone(), active: true, respawnAt: 0 });
    });
  }

  /** Синие аптечки с белым крестом: +25 здоровья */
  private buildMedkits(): void {
    const box = MeshBuilder.CreateBox("medBox", { width: 0.7, height: 0.45, depth: 0.5 }, this.scene);
    box.material = flatMat(this.scene, "#1f3f9e", 0.25);
    const crossA = MeshBuilder.CreateBox("medCrossA", { width: 0.36, height: 0.47, depth: 0.1 }, this.scene);
    const crossB = MeshBuilder.CreateBox("medCrossB", { width: 0.1, height: 0.47, depth: 0.36 }, this.scene);
    crossA.position.y = crossB.position.y = 0.01;
    crossA.scaling.set(1, 1, 5.2);
    crossB.scaling.set(5.2, 1, 1);
    // Крест сверху: тонкие плашки на крышке
    for (const c of [crossA, crossB]) {
      c.scaling.y = 0.04;
      c.position.y = 0.235;
      c.material = flatMat(this.scene, "#ffffff", 0.4);
    }
    crossA.scaling.set(0.9, 0.04, 1.0);
    crossB.scaling.set(1.0, 0.04, 0.9);
    const med = Mesh.MergeMeshes([box, crossA, crossB], true, true, undefined, false, true)!;
    med.name = "medkit";
    med.isVisible = false;
    med.isPickable = false;
    // Места — свободные точки карты (детерминированно), по одной на зону
    const rnd = makeRng(31);
    // Зоны уровня 1, на уровне 2 растягиваются на большую карту
    const k = this.world.level === 2 ? 1.5 : this.world.level === 3 ? 0.65 : 1;
    const zones: [number, number, number, number][] = (
      [
        [-40, -20, 40, 20],
        [-60, 20, -15, 60],
        [15, -60, 60, -15],
        [-60, -60, -20, -20],
        [20, 20, 60, 60],
        [-20, -40, 20, -15],
        [-20, 20, 20, 45],
        [-40, -20, 40, 20],
      ] as [number, number, number, number][]
    ).map(([a, b, c, d]) => [a * k, b * k, c * k, d * k]);
    zones.forEach(([x0, z0, x1, z1], i) => {
      for (let k = 0; k < 40; k++) {
        const x = x0 + rnd() * (x1 - x0);
        const z = z0 + rnd() * (z1 - z0);
        if (!this.world.isWalkable(x, z)) continue;
        const inst = med.createInstance(`medkit${i}`);
        inst.position.set(x, this.world.heightAt(x, z) + 0.24, z);
        inst.isPickable = false;
        this.medkits.push({ mesh: inst, pos: new Vector3(x, this.world.heightAt(x, z), z), active: true, respawnAt: 0 });
        break;
      }
    });
  }

  private pickupMedkits(): void {
    const p = this.player;
    for (const m of this.medkits) {
      if (!m.active) {
        if (this.now >= m.respawnAt) {
          m.active = true;
          m.mesh.setEnabled(true);
          this.relocate(m, 0.24);
        }
        continue;
      }
      if (p.hp >= RULES.maxHp) continue;
      const dx = m.pos.x - p.position.x;
      const dz = m.pos.z - p.position.z;
      if (dx * dx + dz * dz < 1.5 * 1.5) {
        m.active = false;
        m.mesh.setEnabled(false);
        m.respawnAt = this.now + RULES.chestRespawnSec;
        p.hp = Math.min(RULES.maxHp, p.hp + RULES.medkitHp);
        this.hud.message(`+${RULES.medkitHp} здоровья`, 1.2, "#6fd3ff");
        this.sfx.pickup();
      }
    }
  }

  /** Снегопад вокруг камеры и белёсая дымка */
  private makeSnowfall(detail: number): void {
    const scene = this.scene;
    scene.fogColor = new Color3(0.86, 0.9, 0.95);
    scene.fogStart = 18;
    scene.fogEnd = 85;
    const tex = new DynamicTexture("flake", { width: 32, height: 32 }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const grd = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 32, 32);
    tex.hasAlpha = true;
    tex.update();
    const ps = new ParticleSystem("snow", detail < 1 ? 600 : 1800, scene);
    ps.particleTexture = tex;
    const emitter = new TransformNode("snowEmitter", scene);
    ps.emitter = emitter as unknown as Vector3;
    ps.minEmitBox = new Vector3(-25, 12, -25);
    ps.maxEmitBox = new Vector3(25, 14, 25);
    ps.direction1 = new Vector3(-0.6, -1, -0.3);
    ps.direction2 = new Vector3(0.6, -1, 0.3);
    ps.minSize = 0.05;
    ps.maxSize = 0.14;
    ps.minLifeTime = 4;
    ps.maxLifeTime = 7;
    ps.emitRate = detail < 1 ? 120 : 320;
    ps.minEmitPower = 1.5;
    ps.maxEmitPower = 2.5;
    ps.gravity = new Vector3(0, -0.5, 0);
    ps.color1 = new Color4(1, 1, 1, 0.9);
    ps.color2 = new Color4(0.9, 0.95, 1, 0.7);
    ps.colorDead = new Color4(1, 1, 1, 0);
    ps.start();
    // Облако снежинок едет за камерой
    scene.onBeforeRenderObservable.add(() => emitter.position.copyFrom(this.camera.position));
  }

  // ---------------- Дроны ----------------

  private updateDrones(dt: number): void {
    if (!this.drones.length) return;
    const targets: DroneTarget[] = [this.playerPrey, ...this.bots.map((b) => this.preyOf(b))];
    const canSee = (from: Vector3, to: Vector3) => {
      const dir = to.subtract(from);
      const len = dir.length();
      return !this.scene.pickWithRay(new Ray(from, dir.scale(1 / len), len), isSolid, true)?.hit;
    };
    for (const d of this.drones) {
      d.update(dt, targets, canSee);
      if (d.lastShot) {
        this.effects.tracer(d.lastShot.from, d.lastShot.to, true);
        this.sfx.laser(clamp(1 - Vector3.Distance(d.pos, this.player.position) / 60, 0.05, 1));
      }
    }
  }

  // ---------------- Торговец, охранники, шипы ----------------

  /** Зверь повержен игроком — шкура падает на землю, её надо подобрать */
  private gainLeather(a: Animal): void {
    this.hud.message(`${a.info.name} повержен — подбери шкуру!`, 1.6, "#ffe1a8");
  }

  private hides: { mesh: Mesh; pos: Vector3; n: number; until: number }[] = [];
  private hideDropped = new Set<Animal>();

  /** Шкура: бурый мех на земле, приподнимается и поблёскивает, чтобы её было видно */
  private dropHide(a: Animal): void {
    const n = a.kind === "bear" ? 3 : a.kind === "moose" ? 2 : 1;
    const size = a.kind === "bear" ? 1.4 : a.kind === "moose" ? 1.2 : 0.9;
    const m = MeshBuilder.CreateDisc("hide", { radius: size / 2, tessellation: 9 }, this.scene);
    m.rotation.x = Math.PI / 2;
    m.scaling.set(1.3, 0.8, 1);
    const color = a.kind === "wolf" ? "#6b6258" : a.kind === "bear" ? "#4a3121" : "#5e4630";
    const mat = flatMat(this.scene, color, 0.15);
    mat.backFaceCulling = false;
    m.material = mat;
    m.isPickable = false;
    const pos = a.pos.clone();
    m.position.set(pos.x, pos.y + 0.06, pos.z);
    this.hides.push({ mesh: m, pos, n, until: this.now + 90 });
  }

  private updateHides(): void {
    for (const a of this.animals) {
      if (!a.alive && !this.hideDropped.has(a)) {
        this.hideDropped.add(a);
        this.dropHide(a);
      } else if (a.alive) this.hideDropped.delete(a);
    }
    const p = this.player;
    for (let i = this.hides.length - 1; i >= 0; i--) {
      const h = this.hides[i];
      h.mesh.position.y = h.pos.y + 0.06 + Math.abs(Math.sin(this.now * 2.5)) * 0.08;
      h.mesh.rotation.z += 0.01;
      const near = p.alive && (p.position.x - h.pos.x) ** 2 + (p.position.z - h.pos.z) ** 2 < 1.6 * 1.6;
      if (near) {
        this.res.leather += h.n;
        this.sfx.pickup();
        this.hud.message(`Шкура! +${h.n} 🟫 кожи (${this.res.leather})`, 1.6, "#ffe1a8");
      }
      if (near || this.now > h.until) {
        h.mesh.dispose();
        this.hides.splice(i, 1);
      }
    }
  }

  /** Где стоит торговец: перед бункером своего клана */
  private traderSpot(): Vector3 {
    const base = this.world.bases[this.player.clan];
    return base.spawns[0].add(base.spawns[1].subtract(base.spawns[0]).scale(0.5)).add(new Vector3(2, 0, 2));
  }

  private nearTrader(): boolean {
    if (!this.trader || this.now > this.traderUntil) return false;
    const t = this.trader.root.position;
    const p = this.player.position;
    return (t.x - p.x) ** 2 + (t.z - p.z) ** 2 < 3.2 * 3.2;
  }

  private guardPrice(clan: ClanId): { wood: number; leather: number } {
    const k = 1 + this.guardsBought[clan] * 0.5;
    return { wood: Math.round(6 * k), leather: Math.round(1 * k) };
  }

  private updateTrader(dt: number): void {
    void dt;
    if (this.state !== "playing" && this.state !== "dead") return;
    if (this.ffa || this.race) return;
    if (this.now >= this.nextTraderAt) {
      this.nextTraderAt = this.now + 60;
      this.traderUntil = this.now + 30;
      if (!this.trader) this.trader = new Humanoid(this.scene, "trader", { clan: this.player.clan, body: "casual_2" });
      const at = this.traderSpot();
      this.trader.root.position.copyFrom(at);
      this.trader.setEnabled(true);
      this.trader.setWeapon("sword");
      this.hud.message("Пришёл торговец к твоему бункеру! (30 с)", 2.4, "#ffe1a8");
      // Вражеский клан тоже закупается: иногда нанимает охранника
      const enemy = enemyClan(this.player.clan);
      if (Math.random() < 0.6) this.hireGuard(enemy);
    }
    if (this.trader && this.trader.root.isEnabled()) {
      // Стоит и поворачивается к игроку
      const d = this.player.position.subtract(this.trader.root.position);
      this.trader.root.rotation.y = Math.atan2(d.x, d.z);
      this.trader.animate(dt, 0, false, 0.15, false);
      if (this.now > this.traderUntil) {
        this.trader.setEnabled(false);
        this.closeShop();
        this.hud.message("Торговец ушёл. Вернётся через полминуты", 1.6, "#ffe1a8");
      }
    }
    if (this.shopOpen) this.renderShop();
    document.body.classList.toggle("near-trader", this.nearTrader());
  }

  private toggleShop(): void {
    if (this.shopOpen) this.closeShop();
    else this.openShop();
  }

  private openShop(): void {
    this.shopOpen = true;
    const el = document.getElementById("shop")!;
    el.classList.remove("hidden");
    if (document.pointerLockElement) document.exitPointerLock();
    if (!el.dataset.bound) {
      el.dataset.bound = "1";
      el.querySelectorAll<HTMLButtonElement>("button[data-buy]").forEach((b) =>
        b.addEventListener("click", () => this.buy(b.dataset.buy as ShopItem)),
      );
      el.querySelector(".shop-close")!.addEventListener("click", () => this.closeShop());
    }
    this.renderShop();
  }

  private closeShop(): void {
    if (!this.shopOpen) return;
    this.shopOpen = false;
    document.getElementById("shop")!.classList.add("hidden");
  }

  private renderShop(): void {
    const el = document.getElementById("shop")!;
    const r = this.res;
    el.querySelector(".shop-res")!.textContent = `У тебя: 🪵 ${r.wood} дерева · 🟫 ${r.leather} кожи`;
    const gp = this.guardPrice(this.player.clan);
    const guards = this.bots.filter((b) => b.guardHome && b.clan === this.player.clan && b.alive).length;
    const set = (key: string, text: string, ok: boolean) => {
      const b = el.querySelector<HTMLButtonElement>(`button[data-buy="${key}"]`)!;
      b.textContent = text;
      b.disabled = !ok;
    };
    const have = (k: InvItem) => (this.inv[k] ? ` · есть ${this.inv[k]}` : "");
    set("guard", `🛡 Охранник (${guards + this.inv.guard}/10) — ${gp.wood} 🪵 + ${gp.leather} 🟫${have("guard")}`, r.wood >= gp.wood && r.leather >= gp.leather && guards + this.inv.guard < 10);
    set("spikes", `⚠️ Шипы — 3 🪵${have("spikes")}`, r.wood >= 3);
    for (const k of ["fenceWeak", "fenceStrong"] as const) {
      const f = FENCE[k];
      set(k, `${f.icon} ${f.name} (бьёт на ${f.zap}) — ${f.wood} 🪵 + ${f.leather} 🟫${have(k)}`, r.wood >= f.wood && r.leather >= f.leather);
    }
    set("weak", "🟢 Лечебная бомба — 2 🪵 + 1 🟫", r.wood >= 2 && r.leather >= 1 && this.bombs.weak < RULES.maxBombs);
    el.querySelector(".shop-left")!.textContent = String(Math.max(0, Math.ceil(this.traderUntil - this.now)));
  }

  private buy(what: ShopItem): void {
    const r = this.res;
    if (what === "guard") {
      const gp = this.guardPrice(this.player.clan);
      const guards = this.bots.filter((b) => b.guardHome && b.clan === this.player.clan && b.alive).length;
      if (r.wood < gp.wood || r.leather < gp.leather || guards + this.inv.guard >= 10) return;
      r.wood -= gp.wood;
      r.leather -= gp.leather;
      this.guardsBought[this.player.clan]++;
      this.inv.guard++;
      this.hud.message("Охранник в инвентаре — T, чтобы поставить", 1.8, "#7dffb0");
    } else if (what === "spikes") {
      if (r.wood < 3) return;
      r.wood -= 3;
      this.inv.spikes++;
      this.hud.message("Шипы в инвентаре — T, чтобы поставить", 1.8, "#7dffb0");
    } else if (what === "fenceWeak" || what === "fenceStrong") {
      const f = FENCE[what];
      if (r.wood < f.wood || r.leather < f.leather) return;
      r.wood -= f.wood;
      r.leather -= f.leather;
      this.inv[what]++;
      this.hud.message(`${f.name} в инвентаре — T, чтобы поставить`, 1.8, "#7dffb0");
    } else {
      if (r.wood < 2 || r.leather < 1 || this.bombs.weak >= RULES.maxBombs) return;
      r.wood -= 2;
      r.leather -= 1;
      this.bombs.weak++;
    }
    this.sfx.pickup();
    this.renderShop();
  }

  /** Нанять охранника клану: появляется у бункера. Не больше 10 живых на клан */
  private hireGuard(clan: ClanId, at?: Vector3): boolean {
    const alive = this.bots.filter((b) => b.guardHome && b.clan === clan && b.alive).length;
    if (alive >= 10) return false;
    const base = this.world.bases[clan];
    const home = at ? at.clone() : base.flagPoint.clone();
    // Переиспользуем выбывшего охранника, если есть (без лишних сеток)
    let g = this.bots.find((b) => b.guardHome && b.clan === clan && !b.alive && b.lives <= 0);
    if (!g) {
      g = new Bot(this.scene, clan, "weakPistol", clan === this.player.clan, home);
      this.bots.push(g);
    }
    g.lives = 1;
    g.guardHome = home;
    const a = Math.random() * Math.PI * 2;
    g.spawn(at ? home : home.add(new Vector3(Math.sin(a) * 6, 0, Math.cos(a) * 6)), a);
    if (!at) this.guardsBought[clan]++;
    return true;
  }

  /** Шипы перед входом бункера: ранят врагов и зверей, 4 срабатывания */
  private spikesMesh(): Mesh {
    const parts: Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const c = MeshBuilder.CreateCylinder("spike", { height: 0.35, diameterTop: 0, diameterBottom: 0.12, tessellation: 4 }, this.scene);
      c.position.set(((i % 3) - 1) * 0.3, 0.17, (Math.floor(i / 3) - 1) * 0.3);
      parts.push(c);
    }
    const plate = MeshBuilder.CreateBox("spikePlate", { width: 1.0, height: 0.04, depth: 1.0 }, this.scene);
    parts.push(plate);
    const m = Mesh.MergeMeshes(parts, true)!;
    m.material = flatMat(this.scene, "#6b6f75");
    m.isPickable = false;
    return m;
  }

  private placeSpikes(clan: ClanId, at: Vector3): void {
    const m = this.spikesMesh();
    m.position.copyFrom(at);
    this.spikes.push({ mesh: m, pos: at, uses: 4, clan, hitAt: new Map() });
  }

  private updateSpikes(): void {
    for (let i = this.spikes.length - 1; i >= 0; i--) {
      const sp = this.spikes[i];
      const stepOn = (pos: Vector3, key: object, hurt: () => void) => {
        if ((pos.x - sp.pos.x) ** 2 + (pos.z - sp.pos.z) ** 2 > 0.75 * 0.75) return;
        if ((sp.hitAt.get(key) ?? -9) > this.now - 1.5) return;
        sp.hitAt.set(key, this.now);
        hurt();
        sp.uses--;
        this.sfx.clang();
      };
      for (const b of this.bots) if (b.alive && b.clan !== sp.clan) stepOn(b.position, b, () => b.takeDamage(25, sp.pos, this.now));
      for (const a of this.animals) if (a.alive) stepOn(a.pos, a, () => a.takeDamage(25, null, this.now));
      if (this.player.clan !== sp.clan && this.player.alive) stepOn(this.player.position, this.player, () => this.damagePlayer(25));
      if (sp.uses <= 0) {
        sp.mesh.dispose();
        this.spikes.splice(i, 1);
      }
    }
  }

  // ---------------- База: инвентарь, стройка, электрозаборы ----------------

  private static readonly INV_ORDER: InvItem[] = ["spikes", "guard", "fenceWeak", "fenceStrong"];

  /** T: следующий предмет из инвентаря (после последнего — выход из стройки) */
  private cycleBuild(): void {
    const own = Game.INV_ORDER.filter((k) => this.inv[k] > 0);
    if (!own.length) {
      this.setBuild(null);
      this.hud.message("Инвентарь пуст — купи у торговца (шипы, охрана, заборы)", 1.8, "#ffb347");
      return;
    }
    const i = this.building ? own.indexOf(this.building) : -1;
    this.setBuild(i + 1 < own.length ? own[i + 1] : null);
  }

  setBuild(item: InvItem | null): void {
    this.ghost?.dispose(false, true);
    this.ghost = null;
    this.building = item;
    document.body.classList.toggle("building", !!item);
    if (!item) return;
    const g = item === "spikes" ? this.spikesMesh() : item === "guard" ? this.guardGhost() : this.fenceMesh(item === "fenceStrong");
    const mat = new StandardMaterial("ghostMat", this.scene);
    mat.diffuseColor = new Color3(0.3, 1, 0.5);
    mat.emissiveColor = new Color3(0.1, 0.5, 0.2);
    mat.alpha = 0.45;
    for (const m of [g, ...g.getChildMeshes()]) {
      m.material = mat;
      m.isPickable = false;
      m.checkCollisions = false;
    }
    this.ghost = g;
    const name = item === "spikes" ? "Шипы" : item === "guard" ? "Охранник" : FENCE[item].name;
    this.hud.message(`Ставим: ${name} (${this.inv[item]}). ${this.opts.touch ? "«Огонь» — поставить" : "Клик — поставить, T — дальше, X — отмена"}`, 2.2, "#7dffb0");
  }

  private guardGhost(): Mesh {
    const m = MeshBuilder.CreateCapsule("guardGhost", { height: 1.8, radius: 0.35 }, this.scene);
    m.bakeTransformIntoVertices(Matrix.Translation(0, 0.9, 0));
    return m;
  }

  /** Куда встанет предмет: перед игроком, на земле */
  private buildSpot(): { pos: Vector3; yaw: number } {
    const p = this.player;
    const d = this.building === "fenceWeak" || this.building === "fenceStrong" ? 2.6 : 2;
    const x = p.position.x + Math.sin(p.yaw) * d;
    const z = p.position.z + Math.cos(p.yaw) * d;
    return { pos: new Vector3(x, this.world.floorAt(x, z, p.position.y + 1), z), yaw: p.yaw };
  }

  private updateBuild(input: Input): void {
    if (input.build) this.cycleBuild();
    if (input.buildCancel && this.building) this.setBuild(null);
    input.build = input.buildCancel = false;
    if (!this.building) return;
    if (this.inv[this.building] <= 0) {
      this.cycleBuild();
      if (!this.building) return;
    }
    const s = this.buildSpot();
    this.ghost!.position.copyFrom(s.pos);
    this.ghost!.rotation.y = s.yaw;
  }

  private placeBuild(): void {
    const item = this.building;
    if (!item || this.inv[item] <= 0) return;
    const { pos, yaw } = this.buildSpot();
    const clan = this.player.clan;
    if (item === "spikes") this.placeSpikes(clan, pos);
    else if (item === "guard") {
      if (!this.hireGuard(clan, pos)) {
        this.hud.message("Охранников уже 10", 1.4, "#ffb347");
        return;
      }
    } else this.addFence(pos, yaw, item === "fenceStrong", clan);
    this.inv[item]--;
    this.sfx.clang();
    this.effects.impact(pos.add(new Vector3(0, 0.3, 0)), false);
    if (this.inv[item] <= 0) this.cycleBuild();
  }

  /** Забор 3 м: столбы и провода под током. Слабый — деревянные столбы, сильный — стальные */
  private fenceMesh(strong: boolean): Mesh {
    const parts: Mesh[] = [];
    for (const x of [-1.5, 0, 1.5]) {
      const post = MeshBuilder.CreateBox("fpost", { width: strong ? 0.14 : 0.12, height: 1.7, depth: strong ? 0.14 : 0.12 }, this.scene);
      post.position.set(x, 0.85, 0);
      parts.push(post);
    }
    const root = Mesh.MergeMeshes(parts, true)!;
    root.material = strong ? flatMat(this.scene, "#7d848c") : this.woodPostMat();
    const wireMat = new StandardMaterial(strong ? "wireStrong" : "wireWeak", this.scene);
    wireMat.emissiveColor = strong ? new Color3(1, 0.85, 0.2) : new Color3(0.35, 0.8, 1);
    wireMat.disableLighting = true;
    const n = strong ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const w = MeshBuilder.CreateBox("fwire", { width: 3, height: 0.03, depth: 0.03 }, this.scene);
      w.position.set(0, 0.3 + (i * 1.25) / (n - 1), 0);
      w.material = wireMat;
      w.parent = root;
      w.isPickable = false;
    }
    root.isPickable = false;
    return root;
  }

  private woodPostMat(): StandardMaterial {
    return flatMat(this.scene, "#6b4a2b");
  }

  addFence(pos: Vector3, yaw: number, strong: boolean, clan: ClanId): Fence {
    const kind = strong ? "fenceStrong" : "fenceWeak";
    const root = this.fenceMesh(strong);
    root.position.copyFrom(pos);
    root.rotation.y = yaw;
    // Невидимая стенка: в неё упираешься, и пули в неё попадают (забор можно сломать)
    const box = MeshBuilder.CreateBox("fenceBox", { width: 3.1, height: 1.8, depth: 0.3 }, this.scene);
    box.position.set(pos.x, pos.y + 0.9, pos.z);
    box.rotation.y = yaw;
    box.isVisible = false;
    box.checkCollisions = true;
    box.isPickable = true;
    const f: Fence = { root, box, pos: pos.clone(), yaw, hp: FENCE[kind].hp, zap: FENCE[kind].zap, clan, hitAt: new Map(), kind };
    box.metadata = { kind: "world", fence: f };
    this.fences.push(f);
    return f;
  }

  removeFence(f: Fence): void {
    f.root.dispose(false, false);
    f.box.dispose();
    this.fences = this.fences.filter((x) => x !== f);
  }

  /** Урон забору (пули, меч, взрывы). Сломан — рассыпается */
  private damageFence(f: Fence, n: number): void {
    if (f.hp <= 0) return;
    f.hp -= n;
    this.effects.impact(f.pos.add(new Vector3(0, 1, 0)), false);
    if (f.hp <= 0) {
      const vol = clamp(1 - Vector3.Distance(f.pos, this.player.position) / 60, 0.1, 1);
      this.sfx.boom(vol * 0.4);
      this.effects.explosion(f.pos.add(new Vector3(0, 0.8, 0)), 1.2);
      this.removeFence(f);
      if (f.clan === this.player.clan) this.hud.message("Твой забор сломали!", 1.4, "#ffb347");
    }
  }

  private hitFenceFrom(mesh: AbstractMesh | null | undefined, n = 1): void {
    const f = mesh?.metadata?.fence as Fence | undefined;
    if (f) this.damageFence(f, n);
  }

  /** Расстояние по земле от точки до линии забора */
  private fenceDist(f: Fence, pos: Vector3): number {
    const ux = Math.cos(f.yaw);
    const uz = -Math.sin(f.yaw);
    const dx = pos.x - f.pos.x;
    const dz = pos.z - f.pos.z;
    const along = clamp(dx * ux + dz * uz, -1.5, 1.5);
    return Math.hypot(dx - ux * along, dz - uz * along);
  }

  /** Ток: кто из врагов коснулся забора — получает удар (раз в секунду) */
  private updateFences(): void {
    for (const f of [...this.fences]) {
      const zap = (pos: Vector3, key: object, hurt: () => void) => {
        if (this.fenceDist(f, pos) > 0.85 || Math.abs(pos.y - f.pos.y) > 2) return;
        if ((f.hitAt.get(key) ?? -9) > this.now - 1) return;
        f.hitAt.set(key, this.now);
        hurt();
        const vol = clamp(1 - Vector3.Distance(f.pos, this.player.position) / 40, 0.1, 1);
        this.sfx.laser(vol);
        this.effects.impact(pos.add(new Vector3(0, 1, 0)), true);
      };
      for (const b of this.bots) if (b.alive && b.clan !== f.clan) zap(b.position, b, () => this.damageBot(b, f.zap));
      for (const a of this.animals) if (a.alive) zap(a.pos, a, () => a.takeDamage(f.zap, null, this.now));
      if (this.player.clan !== f.clan && this.player.alive) zap(this.player.position, this.player, () => this.damagePlayer(f.zap));
    }
  }

  // ---------------- Падающие деревья ----------------

  private updateFallingTrees(dt: number): void {
    for (const at of this.world.updateTrees(dt).landed) {
      const vol = clamp(1 - Vector3.Distance(at, this.player.position) / 60, 0.1, 1);
      this.sfx.boom(vol * 0.5);
      this.effects.impact(at, false);
      this.effects.impact(at.add(new Vector3(0.8, 0, 0.5)), false);
    }
  }

  // ---------------- Машины ----------------

  private nearestCar(): (typeof this.world.cars)[number] | null {
    const p = this.player.position;
    let best: (typeof this.world.cars)[number] | null = null;
    let bd = 3.2 * 3.2;
    for (const c of this.world.cars) {
      const d = (c.mesh.position.x - p.x) ** 2 + (c.mesh.position.z - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private updateCarHint(): void {
    const trader = this.nearTrader();
    const near = !this.race && (trader || !!this.driving || !!this.nearestCar());
    document.body.classList.toggle("near-car", near && this.state === "playing");
    const hint = document.getElementById("car-hint");
    if (hint) hint.textContent = trader ? (this.shopOpen ? "" : "E — торговать") : this.driving ? "E — выйти из машины" : "E — сесть в машину";
    const btn = document.getElementById("btn-car");
    if (btn) btn.textContent = trader ? "Торговец" : "Машина";
  }

  private toggleCar(): void {
    if (this.driving) {
      this.exitCar();
      return;
    }
    const car = this.nearestCar();
    if (!car || this.scoped) return;
    this.driving = car;
    this.carSpeed = 0;
    const p = this.player;
    p.yaw = car.yaw;
    p.collider.checkCollisions = false;
    p.humanoid.setEnabled(false);
    this.viewmodel.setEnabled(false);
    this.hud.message("За рулём! W — газ, S — тормоз, A/D — руль, E — выйти", 2.4, "#ffffff");
  }

  private exitCar(): void {
    const car = this.driving;
    if (!car) return;
    this.driving = null;
    this.carSpeed = 0;
    const p = this.player;
    // Выходим у левой двери (или справа, если там стена)
    const right = new Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    const c = car.mesh.position;
    let spot = c.add(right.scale(-2.1));
    if (!this.world.isWalkable(spot.x, spot.z)) spot = c.add(right.scale(2.1));
    p.collider.position.set(spot.x, 0.05, spot.z);
    p.collider.checkCollisions = true;
    p.humanoid.setEnabled(true);
    this.setFirstPerson(this.firstPerson);
  }

  private updateCar(dt: number): void {
    const car = this.driving!;
    const input = this.input;
    const p = this.player;
    // Газ, тормоз/задний ход, трение
    const throttle = input.moveZ;
    if (throttle > 0.1) this.carSpeed += 9 * throttle * dt;
    else if (throttle < -0.1) this.carSpeed += (this.carSpeed > 0.5 ? 16 : 6) * throttle * dt;
    else this.carSpeed -= Math.sign(this.carSpeed) * Math.min(Math.abs(this.carSpeed), 3 * dt);
    if (this.race) {
      // До старта стоим; вне асфальта машина вязнет
      if (!this.race.started) this.carSpeed = 0;
      const ri = this.race.nearestIdx(car.mesh.position, this.race.player.idx);
      const top = this.race.offRoad(car.mesh.position, ri) ? RACE_OFFROAD_SPEED : RACE_TOP_SPEED;
      if (this.carSpeed > top) this.carSpeed = Math.max(top, this.carSpeed - 12 * dt);
      this.carSpeed = clamp(this.carSpeed, -5, RACE_TOP_SPEED);
    } else this.carSpeed = clamp(this.carSpeed, -5, 14);
    // Руль: поворачивает тем сильнее, чем быстрее едем (на месте не крутится)
    const steer = input.moveX;
    const k = clamp(Math.abs(this.carSpeed) / 4, 0, 1);
    car.yaw += steer * 1.5 * k * Math.sign(this.carSpeed || 1) * dt;
    car.mesh.rotation.y = car.yaw - Math.PI / 2;
    // Мышь крутит только камеру вокруг машины, а не руль
    p.yaw = car.yaw + clamp(p.yaw - car.yaw, -1.2, 1.2) * 0.98;
    const fwd = new Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    const before = car.mesh.position.clone();
    car.mesh.moveWithCollisions(fwd.scale(this.carSpeed * dt));
    car.mesh.position.y = this.world.heightAt(car.mesh.position.x, car.mesh.position.z);
    const moved = Vector3.Distance(before, car.mesh.position);
    // Врезались — скорость гаснет
    if (moved < Math.abs(this.carSpeed) * dt * 0.4) this.carSpeed *= 0.3;
    const lim = MAP_HALF - 2;
    car.mesh.position.x = clamp(car.mesh.position.x, -lim, lim);
    car.mesh.position.z = clamp(car.mesh.position.z, -lim, lim);
    // Игрок «сидит» в машине: его позиция — для ботов, флага и камеры
    p.collider.position.set(car.mesh.position.x, 0.05, car.mesh.position.z);
    // Таран: враг или зверь перед капотом на скорости
    if (Math.abs(this.carSpeed) > 5) {
      const front = car.mesh.position.add(fwd.scale(Math.sign(this.carSpeed) * 1.6));
      const ram = (pos: Vector3, key: object, hurt: (d: number) => void) => {
        if ((this.ramCooldown.get(key) ?? 0) > this.now) return;
        if ((pos.x - front.x) ** 2 + (pos.z - front.z) ** 2 > 1.7 * 1.7) return;
        this.ramCooldown.set(key, this.now + 1);
        hurt(Math.round(25 + Math.abs(this.carSpeed) * 4));
        this.sfx.clang();
        this.carSpeed *= 0.6;
      };
      for (const b of this.bots) if (b.alive && this.foeOfPlayer(b)) ram(b.position, b, (d) => this.damageBot(b, d));
      for (const a of this.animals) if (a.alive) ram(a.pos, a, (d) => a.takeDamage(d, this.playerPrey, this.now));
    }
  }

  // ---------------- Меч ----------------

  /** Держишь кнопку — копится замах (до двойного урона за 3 с), отпускаешь — удар */
  private updateMelee(fire: boolean): void {
    if (this.inDome() || this.scoped || this.blocking) {
      this.chargeFrom = -1;
      return;
    }
    if (fire && this.chargeFrom < 0) this.chargeFrom = this.now;
    // Подняли меч для замаха — в руках видно, как он отходит назад
    const charge = this.chargeFrom >= 0 ? clamp((this.now - this.chargeFrom) / MELEE.chargeSec, 0, 1) : 0;
    this.vmCharge = charge;
    if (!fire && this.chargeFrom >= 0) {
      this.chargeFrom = -1;
      if (this.now < this.nextShotAt) return;
      this.nextShotAt = this.now + MELEE.swingSec;
      this.strike(1 + charge * (MELEE.maxCharge - 1));
    }
  }

  private strike(mult: number): void {
    const p = this.player;
    const base = SWORDS[p.clan][p.swordLevel - 1].damage;
    const dmg = Math.round(base * mult);
    p.humanoid.swing();
    this.vmSwing = 1;
    this.sfx.swing(mult);
    p.lastShotAt = this.now;
    // Ближайшая цель перед собой в пределах досягаемости (сектор ~±50°)
    const f = new Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    let best: { d: number; bot?: Bot; beast?: Animal } | null = null;
    const consider = (pos: Vector3, extra: number, item: { bot?: Bot; beast?: Animal }) => {
      const to = pos.subtract(p.position);
      to.y = 0;
      const d = to.length();
      if (d > MELEE.reach + extra) return;
      if (d > 0.3 && Vector3.Dot(to.scale(1 / d), f) < 0.64) return;
      if (!best || d < best.d) best = { d, ...item };
    };
    for (const b of this.bots) if (b.alive && this.foeOfPlayer(b)) consider(b.position, 0, { bot: b });
    for (const a of this.animals) if (a.alive) consider(a.pos, a.info.radius, { beast: a });
    const hit = best as { d: number; bot?: Bot; beast?: Animal } | null;
    if (!hit) {
      // Никого рядом — может, это дерево? Удар мечом по стволу даёт дерево для торговца
      for (const fc of this.fences) {
        const to = fc.pos.subtract(p.position);
        if (fc.clan !== p.clan && this.fenceDist(fc, p.position) < 1.6 && Vector3.Dot(to, f) > 0) {
          this.sfx.clang();
          this.damageFence(fc, 1);
          return;
        }
      }
      for (const tr of this.world.treeList) {
        if (tr.fallT > 0) continue;
        const to = tr.pos.subtract(p.position);
        to.y = 0;
        const d = to.length();
        if (d < 2.4 && Vector3.Dot(to.scale(1 / Math.max(d, 0.01)), f) > 0.5) {
          this.res.wood++;
          this.sfx.chop();
          this.effects.impact(tr.pos.add(new Vector3(0, 1.2, 0)), false);
          if (this.world.chopTree(tr, Math.atan2(to.x, to.z))) {
            this.res.wood += 3;
            this.hud.message(`Дерево падает! +4 🪵 (${this.res.wood})`, 1.4, "#ffe1a8");
          } else this.hud.message(`+1 🪵 (${this.res.wood}) · ещё ударов: ${tr.hp}`, 0.8, "#ffe1a8");
          return;
        }
      }
      return;
    }
    this.sfx.clang();
    if (hit.bot) {
      this.damageBot(hit.bot, dmg);
      this.effects.impact(hit.bot.position.add(new Vector3(0, 1.2, 0)), true);
    } else if (hit.beast) {
      const killed = hit.beast.takeDamage(dmg, this.playerPrey, this.now);
      this.hud.hit(killed);
      if (killed) this.gainLeather(hit.beast);
      this.effects.impact(hit.beast.pos.add(new Vector3(0, hit.beast.info.height * 0.6, 0)), true);
    }
    if (mult > 1.5) this.hud.message(`Сильный удар ×${mult.toFixed(1)}`, 0.9, "#ffe14a");
  }

  private vmCharge = 0;
  private vmSwing = 0;
  private vmSwords: TransformNode[] = [];

  private setVmSwordLevel(level: number): void {
    this.vmSwords.forEach((m, i) => m.setEnabled(i === level - 1));
  }

  // ---------------- Лечебные бомбы и купол ----------------

  private inDome(): boolean {
    const d = this.dome;
    if (!d) return false;
    const p = this.player.position;
    return (p.x - d.center.x) ** 2 + (p.z - d.center.z) ** 2 < RULES.domeRadius ** 2;
  }

  private throwBomb(kind: "weak" | "strong" | "any"): void {
    const k = kind === "any" ? (this.bombs.weak > 0 ? "weak" : "strong") : kind;
    if (this.bombs[k] <= 0) {
      this.hud.message(k === "weak" ? "Нет слабых лечебных бомб" : "Нет сильных лечебных бомб", 1.2, "#ffb347");
      return;
    }
    this.bombs[k]--;
    this.removeDome();
    const total = k === "weak" ? RULES.domeWeakSec : RULES.domeStrongSec;
    const mesh = MeshBuilder.CreateSphere("dome", { diameter: RULES.domeRadius * 2, segments: 24 }, this.scene);
    const m = new StandardMaterial("domeMat", this.scene);
    m.diffuseColor = new Color3(0.4, 1, 0.75);
    m.emissiveColor = new Color3(0.15, 0.5, 0.35);
    m.specularColor = new Color3(0.8, 1, 0.9);
    m.alpha = 0.22;
    m.backFaceCulling = false;
    mesh.material = m;
    mesh.isPickable = false;
    const c = this.player.position.clone();
    mesh.position.set(c.x, 0, c.z);
    this.dome = { mesh, center: c, until: this.now + total, total };
    this.sfx.pickup();
    this.hud.message(`Купол бессмертия на ${total < 60 ? total + " с" : total / 60 + " мин"} — под ним не стреляют`, 2.2, "#7dffb0");
  }

  private removeDome(): void {
    if (!this.dome) return;
    this.dome.mesh.material?.dispose();
    this.dome.mesh.dispose();
    this.dome = null;
  }

  private updateDome(dt: number): void {
    const d = this.dome;
    if (!d) return;
    const left = d.until - this.now;
    if (left <= 0) {
      this.removeDome();
      this.hud.message("Купол исчез", 1.2, "#ffb347");
      return;
    }
    // Последние 5 секунд купол мигает
    (d.mesh.material as StandardMaterial).alpha = left < 5 ? 0.12 + 0.12 * Math.abs(Math.sin(this.now * 8)) : 0.22;
    const p = this.player;
    if (this.inDome() && p.alive) {
      p.invulnerableUntil = Math.max(p.invulnerableUntil, this.now + 0.15);
      p.hp = Math.min(RULES.maxHp, p.hp + RULES.domeHealPerSec * dt);
    }
  }

  // ---------------- Липучка ----------------

  /** Прилепить цель: розовая лужа слизи у ног на всё время */
  private stick(pos: Vector3, apply: () => void, r: number, who: string): void {
    apply();
    const m = MeshBuilder.CreateCylinder("goo", { height: 0.12, diameter: r * 2.4, tessellation: 14 }, this.scene);
    const mat = flatMat(this.scene, "#ff5ad8", 0.35);
    mat.alpha = 0.8;
    m.material = mat;
    m.isPickable = false;
    this.ice.push({ mesh: m, until: this.now + STICKY.stuckSec, follow: pos, y: 0.05 });
    this.sfx.shot("sticky");
    this.hud.message(`${who} прилип на ${STICKY.stuckSec} с!`, 1.4, "#ff9be8");
  }

  // ---------------- Боевые бомбы ----------------

  private throwCombat(kind: "boom" | "frost" | "combat"): void {
    const k = kind === "combat" ? (this.bombs.boom > 0 ? "boom" : "frost") : kind;
    if (this.bombs[k] <= 0) {
      this.hud.message(k === "boom" ? "Нет взрывных бомб" : "Нет замораживающих бомб", 1.2, "#ffb347");
      return;
    }
    if (this.inDome()) {
      this.hud.message("Из-под купола не бросают", 1.2, "#7dffb0");
      return;
    }
    this.bombs[k]--;
    const p = this.player;
    // Бросок по дуге из руки по направлению взгляда (чуть вверх)
    const dir = dirFromYawPitch(p.yaw, p.pitch - 0.25);
    const pos = p.position.add(new Vector3(0, p.eyeHeight - 0.2, 0)).add(dir.scale(0.6));
    const mesh = MeshBuilder.CreateSphere("bomb", { diameter: 0.22, segments: 8 }, this.scene);
    mesh.material = flatMat(this.scene, k === "boom" ? "#2a2a2a" : "#7fd8ff", k === "boom" ? 0 : 0.4);
    mesh.isPickable = false;
    mesh.position.copyFrom(pos);
    this.thrown.push({ mesh, pos, vel: dir.scale(16), kind: k, clan: p.clan });
    this.sfx.swing(0.7);
  }

  private updateThrown(dt: number): void {
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      t.vel.y -= 14 * dt;
      const step = t.vel.scale(dt);
      const len = step.length();
      // Врезалась в стену, стекло или землю — срабатывает
      const hit = this.scene.pickWithRay(new Ray(t.pos, step.scale(1 / len), len), isSolid, false);
      let at: Vector3 | null = null;
      if (hit?.hit && hit.pickedPoint) at = hit.pickedPoint.clone();
      t.pos.addInPlace(step);
      const floor = this.world.floorAt(t.pos.x, t.pos.z, t.pos.y);
      if (!at && t.pos.y <= floor + 0.1) at = new Vector3(t.pos.x, floor + 0.1, t.pos.z);
      t.mesh.position.copyFrom(t.pos);
      if (at) {
        t.mesh.dispose();
        this.thrown.splice(i, 1);
        if (t.kind === "boom") this.explode(at, t.clan);
        else this.freezeAt(at, t.clan);
      }
    }
    for (let i = this.ice.length - 1; i >= 0; i--) {
      const c = this.ice[i];
      c.mesh.position.set(c.follow.x, c.follow.y + (c.y ?? 0.95), c.follow.z);
      if (this.now >= c.until) {
        c.mesh.dispose();
        this.ice.splice(i, 1);
      }
    }
  }

  /** Бот бросает бомбу по дуге точно в цель (гравитация как у броска игрока) */
  private botThrow(b: Bot, kind: "boom" | "frost", t: Target): void {
    const from = b.humanoid.getMuzzlePosition();
    const to = t.pos.add(new Vector3(0, 0.3, 0));
    const d = to.subtract(from);
    const horiz = Math.hypot(d.x, d.z);
    const h = 12; // м/с по горизонтали
    const time = Math.max(0.3, horiz / h);
    const vel = new Vector3((d.x / horiz) * h, (d.y + 0.5 * 14 * time * time) / time, (d.z / horiz) * h);
    const mesh = MeshBuilder.CreateSphere("bomb", { diameter: 0.22, segments: 8 }, this.scene);
    mesh.material = flatMat(this.scene, kind === "boom" ? "#2a2a2a" : "#7fd8ff", kind === "boom" ? 0 : 0.4);
    mesh.isPickable = false;
    mesh.position.copyFrom(from);
    this.thrown.push({ mesh, pos: from.clone(), vel, kind, clan: b.clan });
    const vol = clamp(1 - Vector3.Distance(from, this.player.position) / 60, 0.1, 0.8);
    this.sfx.swing(vol);
    if (t === this.playerTarget) this.hud.message(kind === "boom" ? "Бомба! Беги!" : "Ледяная бомба! Уходи!", 1.2, "#ff6b5a");
  }

  /** Взрыв: урон по площади (не по своим), звери тоже, окна в радиусе бьются */
  private explode(at: Vector3, clan: ClanId): void {
    const R = RULES.blastRadius;
    const vol = clamp(1 - Vector3.Distance(at, this.player.position) / 80, 0.15, 1);
    this.sfx.boom(vol);
    this.effects.explosion(at, R);
    const dmgAt = (pos: Vector3) => {
      const d = Vector3.Distance(at, pos.add(new Vector3(0, 0.9, 0)));
      if (d > R) return 0;
      return Math.round(RULES.blastDamage * (1 - (d / R) * 0.67));
    };
    for (const b of this.bots) {
      if (!b.alive || b.clan === clan) continue;
      const dmg = dmgAt(b.position);
      if (dmg > 0) this.damageBot(b, dmg);
    }
    for (const a of this.animals) {
      if (!a.alive) continue;
      const dmg = dmgAt(a.pos);
      if (dmg > 0) a.takeDamage(dmg, this.playerPrey, this.now);
    }
    if (this.player.clan !== clan) {
      const dmg = dmgAt(this.player.position);
      if (dmg > 0) this.damagePlayer(dmg);
    }
    for (const w of this.world.windows) if (!w.broken && Vector3.Distance(w.center, at) < R) this.shatter(w);
    for (const f of [...this.fences]) if (f.clan !== clan && Vector3.Distance(f.pos, at) < R) this.damageFence(f, 5);
    if (this.race && clan === this.player.clan) this.kills += this.race.blast(at, R, (d) => Math.round(RULES.blastDamage * (1 - Math.min(1, d / R) * 0.67)));
    // Камера вздрагивает, если взрыв рядом
    if (vol > 0.6) this.vmKick = 1;
  }

  /** Заморозка: враги и звери в зоне стоят во льду 10 секунд */
  private freezeAt(at: Vector3, clan: ClanId): void {
    const R = RULES.frostRadius;
    const vol = clamp(1 - Vector3.Distance(at, this.player.position) / 80, 0.15, 1);
    this.sfx.freeze(vol);
    this.effects.frost(at, R);
    const until = this.now + RULES.frostSec;
    if (this.race && clan === this.player.clan) {
      const n = this.race.freeze(at, R, until);
      if (n) this.hud.message(`Заморожено машин: ${n}`, 1.4, "#9fe8ff");
    }
    const iceMat = flatMat(this.scene, "#bfefff", 0.35);
    iceMat.alpha = 0.45;
    const encase = (pos: Vector3, h: number, r: number) => {
      const m = MeshBuilder.CreateBox("ice", { width: r * 2.2, height: h, depth: r * 2.2 }, this.scene);
      m.material = iceMat;
      m.isPickable = false;
      this.ice.push({ mesh: m, until, follow: pos });
    };
    let n = 0;
    for (const b of this.bots) {
      if (!b.alive || b.clan === clan || Vector3.Distance(b.position, at) > R) continue;
      b.frozenUntil = until;
      encase(b.position, 1.95, 0.4);
      n++;
    }
    for (const a of this.animals) {
      if (!a.alive || Vector3.Distance(a.pos, at) > R) continue;
      a.frozenUntil = until;
      encase(a.pos, a.info.height + 0.3, a.info.radius + 0.2);
      n++;
    }
    const p = this.player;
    if (p.clan !== clan && p.alive && !this.inDome() && Vector3.Distance(p.position, at) <= R) {
      this.playerFrozenUntil = until;
      if (this.driving) this.exitCar();
      encase(p.position, 1.95, 0.4);
      this.hud.message("Тебя заморозили! 10 секунд во льду", 2, "#9fe8ff");
    } else if (n > 0) this.hud.message(`Заморожено: ${n}`, 1.4, "#9fe8ff");
  }

  // ---------------- Окна ----------------

  /** Стекло разбито: звон, осколки, проём свободен */
  private shatter(w: WindowPane): void {
    if (w.broken) return;
    this.world.breakWindow(w);
    const vol = clamp(1 - Vector3.Distance(w.center, this.player.position) / 60, 0.1, 1);
    this.sfx.glass(vol);
    this.effects.impact(w.center, false);
    this.effects.impact(w.center.add(new Vector3(0, -0.3, 0)), false);
  }

  /** Залезть в разбитое окно: подойти вплотную и идти в него — перелезаем на другую сторону */
  private tryVault(): void {
    const p = this.player;
    if (!p.alive || this.input.moveZ <= 0.3) return;
    const fwd = new Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    for (const w of this.world.windows) {
      if (!w.broken) continue;
      const to = w.center.subtract(p.position);
      to.y = 0;
      const along = Vector3.Dot(to, w.normal); // расстояние до плоскости стены
      const side = to.subtract(w.normal.scale(along)).length(); // вбок от центра окна
      if (Math.abs(along) > 0.9 || side > 0.5) continue;
      // Идём в сторону стены (с любой стороны)
      const into = Math.sign(along) * Vector3.Dot(fwd, w.normal);
      if (into < 0.5) continue;
      const target = w.center.add(w.normal.scale(Math.sign(along) * 0.9));
      p.collider.position.set(target.x, 0.05, target.z);
      this.hud.message("Залез в окно", 0.8, "#ffffff");
      return;
    }
  }

  // ---------------- Звери ----------------

  /** Стая волков и медведь в лесу, лоси на лугах */
  private spawnAnimals(): void {
    const near = (x: number, z: number) => this.world.randomWalkPoint(this.rng, new Vector3(x, 0, z), 6);
    const place: [Animal["kind"], number, number][] =
      this.world.level === 3 || this.world.level === 5
        ? []
        : this.world.level === 2
        ? [
            ["wolf", 55, 60],
            ["wolf", 57, 62],
            ["wolf", 53, 57],
            ["wolf", 70, 35],
            ["bear", 30, 80],
            ["bear", 70, -45],
            ["moose", -30, -15],
            ["moose", 25, -30],
          ]
        : [
            ["wolf", -36, 40],
            ["wolf", -34, 42],
            ["wolf", -38, 37],
            ["bear", -52, 22],
            ["moose", 40, 30],
            ["moose", -15, -45],
          ];
    for (const [kind, x, z] of place) this.animals.push(new Animal(this.scene, kind, near(x, z)));
    const p = this.player;
    const game = this;
    this.playerPrey = {
      pos: p.position,
      get alive() {
        return p.alive && game.state === "playing";
      },
      hurt: (dmg) => this.damagePlayer(dmg),
    };
  }

  private preyOf(b: Bot): Prey {
    let pr = this.botPrey.get(b);
    if (!pr) {
      pr = {
        pos: b.position,
        get alive() {
          return b.alive;
        },
        hurt: (dmg, from) => b.takeDamage(dmg, from, this.now),
      };
      this.botPrey.set(b, pr);
    }
    return pr;
  }

  private animalTarget(a: Animal): Target {
    let t = this.animalTargets.get(a);
    if (!t) {
      t = {
        pos: a.pos,
        get alive() {
          return a.alive;
        },
        clan: null,
        bot: null,
        animal: a,
      };
      this.animalTargets.set(a, t);
    }
    return t;
  }

  private updateAnimals(dt: number): void {
    const prey: Prey[] = [this.playerPrey, ...this.bots.map((b) => this.preyOf(b))];
    const walkPoint = (near: Vector3, r: number) => this.world.randomWalkPoint(Math.random, near, r);
    const walkable = (x: number, z: number) => this.world.isWalkable(x, z);
    const ground = (x: number, z: number) => this.world.heightAt(x, z);
    for (const a of this.animals) a.update(dt, this.now, prey, walkPoint, walkable, ground);
  }

  // ---------------- Матч ----------------

  resetMatch(): void {
    this.now = 0;
    // Таймеры оружия считаются от this.now — после сброса времени их тоже обнуляем,
    // иначе после «Играть снова» стрельба молчит, пока не догонит старое время
    this.nextShotAt = 0;
    this.emptyWarnAt = 0;
    this.kills = 0;
    this.matchLeft = RULES.protoMatchSeconds;
    this.teamKills = { dragons: 0, snakes: 0 };
    for (const c of ["dragons", "snakes"] as const) {
      this.capture[c] = { by: null, t: 0, startedAt: 0 };
      this.world.bases[c].flag.position.y = 7.2;
    }
    this.state = "playing";
    this.deadTimer = 0;
    this.player.lives = RULES.lives;
    // Оружие — только выбранное перед матчем (рогатку можно ещё найти в сундуке)
    this.player.owned.clear();
    // Снег: только клановое оружие и рогатка, без бомб
    // Гонки: «действуют все боеприпасы» — всё оружие сразу
    const kit = this.ffa ? (["clanWeapon", "slingshot"] as WeaponId[]) : this.race ? WEAPON_ORDER.filter((w) => w !== "sword") : this.loadout.weapons;
    for (const w of kit) this.player.owned.add(w);
    this.player.swordLevel = 1;
    this.player.humanoid.setSwordLevel(1);
    this.setVmSwordLevel(1);
    this.chargeFrom = -1;
    const lb = this.ffa ? [] : this.loadout.bombs;
    this.bombs = { weak: lb.includes("weak") ? 1 : 0, strong: 0, boom: lb.includes("boom") ? 1 : 0, frost: lb.includes("frost") ? 1 : 0 };
    if (this.race) this.bombs = { weak: 2, strong: 1, boom: 3, frost: 2 };
    this.playerFrozenUntil = -1;
    this.res = { wood: 0, leather: 0 };
    for (const h of this.hides) h.mesh.dispose();
    this.hides = [];
    this.nextTraderAt = 60;
    this.traderUntil = -1;
    this.trader?.setEnabled(false);
    this.closeShop();
    this.guardsBought = { dragons: 0, snakes: 0 };
    for (const sp of this.spikes) sp.mesh.dispose();
    this.spikes = [];
    for (const fc of [...this.fences]) this.removeFence(fc);
    this.inv = { spikes: 0, guard: 0, fenceWeak: 0, fenceStrong: 0 };
    this.setBuild(null);
    for (const t of this.world.treeList) if (t.fallT > 0) this.world.regrowTree(t);
    // Купленные охранники уходят: новый матч — с нуля
    for (const b of this.bots.filter((x) => x.guardHome)) {
      b.lives = 0;
      b.hp = 0;
      b.state = "dead";
      b.humanoid.setEnabled(false);
    }
    for (const t of this.thrown) t.mesh.dispose();
    this.thrown = [];
    for (const c of this.ice) c.mesh.dispose();
    this.ice = [];
    this.removeDome();
    // Первое из выбранного оружия
    const first = WEAPON_ORDER.findIndex((w) => this.player.owned.has(w));
    this.player.selectWeapon(Math.max(0, first));
    this.respawnPlayer();
    this.bots.forEach((b, i) => {
      if (b.guardHome) return;
      b.lives = RULES.lives;
      if (this.ffa) {
        const sp = this.world.ffaSpawns[(i + 1) % this.world.ffaSpawns.length];
        b.spawn(sp, Math.atan2(-sp.x, -sp.z));
        b.bombs = { boom: 0, frost: 0 };
        return;
      }
      const base = this.world.bases[b.clan];
      const sp = base.spawns[i % base.spawns.length];
      b.spawn(sp, base.facing);
    });
    for (const m of this.medkits) {
      m.active = true;
      m.mesh.setEnabled(true);
    }
    for (const a of this.animals) a.spawn(a.pos.clone());
    this.world.repairWindows();
    if (this.driving) this.exitCar();
    for (const c of this.world.cars) {
      c.mesh.position.copyFrom(c.home);
      c.yaw = c.homeYaw;
      c.mesh.rotation.y = c.yaw - Math.PI / 2;
    }
    for (const c of this.chests) {
      c.active = true;
      c.mesh.setEnabled(true);
    }
    this.effects.clearOrbs();
    this.hud.reset();
    this.input.reset();
    if (this.race) {
      this.race.reset();
      this.enterRaceCar(this.world.track!.grid[0].pos, this.world.track!.grid[0].yaw);
      this.matchLeft = 20 * 60;
    }
    document.body.classList.toggle("race", !!this.race);
  }

  /** Гонка: игрок всегда за рулём своей машины */
  private enterRaceCar(pos: Vector3, yaw: number): void {
    const car = this.world.cars[0];
    car.mesh.position.set(pos.x, 0, pos.z);
    car.yaw = yaw;
    car.mesh.rotation.y = yaw - Math.PI / 2;
    this.player.collider.position.set(pos.x, 0.05, pos.z);
    this.player.yaw = yaw;
    if (!this.driving) this.toggleCar();
    this.carSpeed = 0;
  }

  private respawnPlayer(): void {
    if (this.race) {
      const sp = this.race.respawnPoint(this.race.player);
      this.player.spawnAt(sp.pos, sp.yaw, this.now);
      this.state = "playing";
      this.playerFrozenUntil = -1;
      this.enterRaceCar(sp.pos, sp.yaw);
      return;
    }
    if (this.ffa) {
      const sp = this.world.ffaSpawns[0];
      this.player.spawnAt(sp, Math.atan2(-sp.x, -sp.z), this.now);
      this.state = "playing";
      this.setFirstPerson(this.firstPerson);
      this.playerFrozenUntil = -1;
      this.sink = 0;
      return;
    }
    // Лёд не переживает смерть
    this.playerFrozenUntil = -1;
    this.ice = this.ice.filter((c) => {
      if (c.follow !== this.player.position) return true;
      c.mesh.dispose();
      return false;
    });
    const base = this.world.bases[this.opts.clan];
    const sp = base.spawns[Math.floor(this.rng() * base.spawns.length)];
    this.player.spawnAt(sp, base.facing, this.now);
    this.state = "playing";
    // После смерти тело было видно — в 1-м лице снова прячем
    this.setFirstPerson(this.firstPerson);
  }

  setScoped(v: boolean): void {
    this.scoped = v;
    const el = document.getElementById("scope")!;
    const spyglass = this.opts.clan === "dragons";
    el.className = v ? (spyglass ? "spyglass" : "binoculars") : "hidden";
    const how = this.input.isTouch ? "нажми ещё раз, чтобы убрать" : "B — убрать";
    (el.firstElementChild as HTMLElement).textContent = `${spyglass ? "Подзорная труба" : "Бинокль"} · ${how}`;
    document.body.classList.toggle("scoped", v);
    // Смотрим глазами персонажа: тело и оружие в руках прячем
    this.player.humanoid.setVisible(!v && !this.firstPerson);
    this.viewmodel.setEnabled(!v && this.firstPerson);
    if (v) {
      this.input.cancelAim();
      this.input.cancelTouchSprint();
    }
    if (!v) this.setFirstPerson(this.firstPerson);
  }

  setFirstPerson(v: boolean): void {
    this.firstPerson = v;
    this.player.humanoid.setVisible(!v);
    this.viewmodel.setEnabled(v);
  }

  // ---------------- Кадр ----------------

  private frame(): void {
    const dtRaw = this.engine.getDeltaTime() / 1000;
    const dt = clamp(dtRaw, 0.001, 0.05);
    this.fpsAcc += dtRaw;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fpsShown = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    if (!this.paused) this.update(dt);
    this.scene.render();
  }

  private update(dt: number): void {
    const input = this.input;
    input.poll();
    this.now += dt;
    const p = this.player;

    if (input.cameraToggle && !this.scoped) this.setFirstPerson(!this.firstPerson);
    if (input.scopeToggle && this.ffa) this.hud.message("В снегах трубы нет", 1, "#9fe8ff");
    else if (input.scopeToggle && this.state === "playing") this.setScoped(!this.scoped);
    if (this.state !== "playing" && this.scoped) this.setScoped(false);
    const sword = p.weapon === "sword";
    // С мечом правая кнопка — щит, а не прицел
    this.blocking = sword && input.aim && !this.scoped && this.state === "playing";
    this.aiming = !sword && !this.ffa && input.aim && !this.scoped && this.state === "playing";
    p.humanoid.blocking = this.blocking;
    // В приближении поворот медленнее — пропорционально углу обзора, чтобы целиться точно
    const zoomK = this.camera.fov / BASE_FOV;
    input.lookDX *= zoomK;
    input.lookDY *= zoomK;
    if (input.weaponSelect !== null) p.selectWeapon(input.weaponSelect);
    if (input.weaponCycle) p.cycleWeapon(input.weaponCycle);
    this.updateViewmodelWeapon();

    if (this.state === "playing") {
      const frozen = this.now < this.playerFrozenUntil;
      if (frozen) {
        // Во льду: только смотреть по сторонам
        input.moveX = input.moveZ = 0;
        input.fire = false;
        input.jumpPressed = false;
        input.use = false;
        input.bomb = null;
      }
      if (input.use && (this.shopOpen || this.nearTrader())) {
        this.toggleShop();
        input.use = false;
      }
      if (input.use && this.race) {
        input.use = false;
        this.hud.message("В гонке из машины не выходят", 1.2, "#ffb347");
      }
      if (input.use) this.toggleCar();
      if (this.driving) this.updateCar(dt);
      else p.update(dt, input, this.now, () => this.canStand(), (x, z, y) => this.world.floorAt(x, z, y));
      this.updateCarHint();
      if (this.driving && this.building) this.setBuild(null);
      if (!this.driving) this.updateBuild(input);
      if (this.driving && this.race && p.weapon !== "sword") {
        if (input.fire) this.tryShoot(!this.prevFire);
      } else if (this.driving) {
        if (input.fire && !this.prevFire) this.hud.message("Из машины не стреляют — выйди (E)", 1.2, "#ffb347");
      } else if (this.building) {
        if (input.fire && !this.prevFire) this.placeBuild();
      } else if (p.weapon === "sword") this.updateMelee(input.fire);
      else if (input.fire) this.tryShoot(!this.prevFire);
      this.prevFire = input.fire;
      this.pickupChests();
      this.pickupMedkits();
      this.tryVault();
      if (input.bomb === "boom" || input.bomb === "frost" || input.bomb === "combat") this.throwCombat(input.bomb);
      else if (input.bomb) this.throwBomb(input.bomb);
    } else {
      this.prevFire = false;
      if (this.state === "dead") {
        this.deadTimer += dt;
        p.humanoid.deathT = clamp(this.deadTimer / 1.1, 0, 1);
        p.humanoid.animate(dt, 0, false, 0, false);
        if (this.deadTimer >= RULES.playerRespawnSec) {
          this.respawnPlayer();
          this.onRespawn();
        }
      }
    }

    const ctx = this.botContext();
    for (const b of this.bots) b.update(dt, ctx);
    this.updateAnimals(dt);
    this.birds.update(dt, this.now);
    this.updateDrones(dt);
    this.updateTrader(dt);
    this.updateSpikes();
    this.updateFences();
    this.updateFallingTrees(dt);
    this.leaves?.update(dt, this.camera.position, this.world.treeList);
    this.updateHides();
    this.updateDome(dt);
    this.updateSnow(dt);
    this.updateThrown(dt);
    if (this.state === "playing" || this.state === "dead") this.updateMatch(dt);

    this.updateChests();
    this.effects.update(dt);
    this.updateCamera(dt);

    const hidden = this.state === "playing" && this.isPlayerHidden();
    this.hud.update(dt, {
      hp: p.hp,
      ammo: p.ammo,
      weapon: p.weapon,
      kills: this.kills,
      lives: p.lives,
      fps: this.fpsShown,
      status: this.blocking ? "Щит" : this.aiming ? "Прицел" : p.crouching ? "Присел" : p.sprinting ? "Бег" : "",
      hidden,
      teams: this.teamCounts(),
      ffaAlive: this.ffa ? this.bots.filter((b) => b.alive || b.lives > 0).length + (p.lives > 0 ? 1 : 0) : 0,
      owned: [...p.owned],
      swordLevel: p.swordLevel,
      res: this.res,
      inv: this.inv,
      building: this.building,
      bombs: this.bombs,
      domeLeft: this.dome ? Math.max(0, this.dome.until - this.now) : 0,
      timeLeft: this.matchLeft,
      capture: this.captureInfo(),
    });
    input.endFrame();
  }

  /** Полоска захвата для HUD: важнее всего захват своего флага */
  private updateRace(dt: number): void {
    const race = this.race!;
    this.matchLeft -= dt;
    const cd = race.countdownText();
    if (cd) this.hud.message(cd, 0.3, "#ffe14a");
    if (this.state === "playing" && race.updatePlayer(this.player.position)) {
      this.endMatch(this.player.clan, `Ты первым прошёл ${RACE_LAPS} кругов!`);
      return;
    }
    const bot = race.updateBots(dt);
    if (bot) {
      this.endMatch(enemyClan(this.player.clan), `${bot.name} первым прошёл ${RACE_LAPS} кругов`);
      return;
    }
    if (race.aliveRivals() === 0) {
      this.endMatch(this.player.clan, "Все соперники выбыли — ты победил!");
      return;
    }
    if (this.matchLeft <= 0) {
      const place = race.place(race.player);
      if (place === 1) this.endMatch(this.player.clan, "Время вышло — ты впереди всех!");
      else this.endMatch(enemyClan(this.player.clan), `Время вышло, ты ${place}-й`);
    }
  }

  private captureInfo(): { text: string; t: number; color: string } | null {
    if (this.race) {
      const r = this.race.player;
      const lap = Math.min(RACE_LAPS, r.lap + 1);
      const frac = (this.race.progress(r) % this.world.track!.cps.length) / this.world.track!.cps.length;
      const total = this.race.racers.filter((x) => !x.out || x.isPlayer).length;
      return { text: `Круг ${lap}/${RACE_LAPS} · место ${this.race.place(r)} из ${total}`, t: frac, color: "#ffe14a" };
    }
    const mine = this.player.clan;
    const own = this.capture[mine];
    if (own.by) return { text: "Твой флаг захватывают!", t: own.t, color: "#ff5a4a" };
    const enemy = this.capture[enemyClan(mine)];
    if (enemy.by) {
      const me = enemy.by === this.playerTarget;
      return { text: me ? "Захватываешь флаг — держись!" : "Наши захватывают флаг!", t: enemy.t, color: "#ffd23a" };
    }
    return null;
  }

  /** Сколько бойцов каждого клана сейчас в строю (игрок считается за свой клан) */
  private teamCounts(): Record<ClanId, number> {
    const n: Record<ClanId, number> = { dragons: 0, snakes: 0 };
    if (this.player.alive && this.state === "playing") n[this.opts.clan]++;
    for (const b of this.bots) if (b.alive && !b.guardHome) n[b.clan]++;
    return n;
  }

  private updateViewmodelWeapon(): void {
    for (const [k, g] of this.vmGuns) g.setEnabled(k === this.player.weapon);
  }

  private canStand(): boolean {
    const p = this.player.position;
    const ray = new Ray(new Vector3(p.x, p.y + 1.0, p.z), new Vector3(0, 1, 0), 0.9);
    return !this.scene.pickWithRay(ray, isWorld, true)?.hit;
  }

  private updateCamera(dt: number): void {
    const p = this.player;
    const cam = this.camera;
    const eye = new Vector3(p.position.x, p.position.y + (this.state === "dead" ? 0.6 : p.eyeHeight), p.position.z);
    cam.rotation.set(p.pitch, p.yaw, 0);
    // Плавное приближение: труба/бинокль ×4.5, прицел ×1.8
    const wantFov = this.scoped ? BASE_FOV / 4.5 : this.aiming ? BASE_FOV / 1.8 : BASE_FOV;
    cam.fov += (wantFov - cam.fov) * Math.min(1, dt * 12);
    if (this.scoped && this.state !== "dead") {
      cam.position.copyFrom(eye);
      return;
    }
    if (this.driving) {
      // За рулём: камера сзади-сверху, смотрит по ходу машины с поправкой мышью
      const c = this.driving.mesh.position;
      const yaw = this.driving.yaw + (p.yaw - this.driving.yaw);
      const back = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const target = c.add(back.scale(7)).add(new Vector3(0, 3.2, 0));
      cam.position.copyFrom(target);
      cam.rotation.set(0.28 + p.pitch * 0.3, yaw, 0);
      return;
    }
    if (this.firstPerson && this.state !== "dead") {
      cam.position.copyFrom(eye);
      // Покачивание оружия при ходьбе и отдача
      this.vmKick = Math.max(0, this.vmKick - dt * 10);
      const bob = p.speed > 0.5 && p.grounded ? Math.sin(this.now * (p.sprinting ? 13 : 9)) * 0.012 : 0;
      this.viewmodel.position.set(0.22, -0.2 + bob - (p.crouching ? 0.01 : 0), 0.42 - this.vmKick * 0.06);
      this.viewmodel.rotation.x = -this.vmKick * 0.15;
      this.viewmodel.rotation.y = 0;
      this.viewmodel.rotation.z = 0;
      if (p.weapon === "sword") {
        this.vmSwing = Math.max(0, this.vmSwing - dt / MELEE.swingSec);
        const s = this.vmSwing;
        if (s > 0) {
          // Взмах справа-сверху вниз-влево
          this.viewmodel.rotation.set(0.9 * s - 0.4, 0.9 * (s - 0.5), -0.6 * s);
        } else if (this.blocking) {
          // Щит: клинок поперёк перед лицом
          this.viewmodel.rotation.set(-0.15, -0.5, 1.4);
          this.viewmodel.position.set(0.12, -0.12, 0.45);
        } else {
          // Замах: клинок уходит назад-вверх, пока держишь кнопку
          this.viewmodel.rotation.set(-0.35 - this.vmCharge * 0.9, 0.2 * this.vmCharge, -0.2 * this.vmCharge);
        }
      }
      return;
    }
    // Третье лицо: камера за правым плечом, не проходит сквозь стены
    const fwd = dirFromYawPitch(p.yaw, p.pitch);
    const right = new Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const pivot = eye.add(right.scale(0.75)).add(new Vector3(0, 0.15, 0));
    const back = fwd.scale(-1);
    const ray = new Ray(pivot, back, this.camDist + 0.3);
    const hit = this.scene.pickWithRay(ray, isWorld, false);
    let d = this.aiming ? 1.9 : this.camDist;
    if (hit?.hit && hit.distance < d + 0.3) d = Math.max(0.3, hit.distance - 0.3);
    const target = pivot.add(back.scale(d));
    // Камера не уходит под землю
    target.y = Math.max(target.y, this.world.floorAt(p.position.x, p.position.z, p.position.y) + 0.3);
    cam.position.copyFrom(target);
  }

  // ---------------- Стрельба игрока ----------------

  private tryShoot(fresh: boolean): void {
    const p = this.player;
    // Из-под купола стрелять нельзя — только прятаться и лечиться (GDD)
    if (this.inDome()) {
      if (fresh) this.hud.message("Из-под купола стрелять нельзя", 1.2, "#7dffb0");
      return;
    }
    // В подзорную трубу не стреляют — сначала убери её (B)
    if (this.scoped) {
      if (fresh) this.hud.message(this.opts.clan === "dragons" ? "Убери подзорную трубу (B)" : "Убери бинокль (B)", 1.2, "#ffe14a");
      return;
    }
    if (this.now < this.nextShotAt) return;
    const w = WEAPONS[p.weapon];
    if (p.ammo < w.ammoPerShot) {
      if (fresh || this.now > this.emptyWarnAt) {
        this.sfx.empty();
        this.hud.message("Нет патронов! Ищи оранжевые сундуки", 2, "#ffb347");
        this.emptyWarnAt = this.now + 2.5;
      }
      this.nextShotAt = this.now + 0.3;
      return;
    }
    this.nextShotAt = this.now + 1 / w.fireRate;
    p.ammo -= w.ammoPerShot;
    p.lastShotAt = this.now;
    if (p.sprinting) this.input.cancelTouchSprint();
    this.sfx.unlock();
    this.sfx.shot(p.weapon);

    const cam = this.camera;
    const aimDir = dirFromYawPitch(p.yaw, p.pitch);
    const spreadK = (this.aiming ? 0.5 : 1) * (p.crouching ? 0.6 : 1) * (p.speed > 4 ? 1.8 : p.speed > 0.5 ? 1.25 : 1) * (p.grounded ? 1 : 2);
    const dir = applySpread(aimDir, w.spread * spreadK);
    // В 3-м лице луч начинается у игрока, а не у камеры
    const origin = this.firstPerson
      ? cam.position.clone()
      : cam.position.add(aimDir.scale(Vector3.Distance(cam.position, p.position.add(new Vector3(0, p.eyeHeight, 0))) * 0.9));

    const wHit = this.scene.pickWithRay(new Ray(origin, dir, w.range), isSolid, false);
    const glassHit = wHit?.hit && wHit.pickedMesh?.metadata?.kind === "glass" ? this.world.windowOf(wHit.pickedMesh) : undefined;
    let maxT = wHit?.hit ? wHit.distance : w.range;
    let target: Bot | null = null;
    for (const b of this.bots) {
      if (!b.alive || !this.foeOfPlayer(b)) continue;
      const bp = b.position;
      const r = rayVsVerticalSegment(origin, dir, maxT, bp.x, bp.y + 0.2, bp.y + 1.62, bp.z);
      if (r.dist < 0.36 && r.t < maxT) {
        maxT = r.t;
        target = b;
      }
    }
    let drone: Drone | null = null;
    for (const dr of this.drones) {
      if (!dr.alive) continue;
      const r = rayVsVerticalSegment(origin, dir, maxT, dr.pos.x, dr.pos.y - 0.15, dr.pos.y + 0.15, dr.pos.z);
      if (r.dist < 0.45 && r.t < maxT) {
        maxT = r.t;
        target = null;
        drone = dr;
      }
    }
    let beast: Animal | null = null;
    for (const a of this.animals) {
      if (!a.alive) continue;
      const ap = a.pos;
      const r = rayVsVerticalSegment(origin, dir, maxT, ap.x, ap.y + 0.15, ap.y + a.info.height, ap.z);
      if (r.dist < a.info.radius && r.t < maxT) {
        maxT = r.t;
        target = null;
        beast = a;
      }
    }
    const end = origin.add(dir.scale(maxT));
    const muzzle = this.firstPerson ? this.vmMuzzle.getAbsolutePosition().clone() : p.humanoid.getMuzzlePosition();
    this.vmKick = 1;
    p.pitch -= p.weapon === "strongPistol" ? 0.018 : 0.006;

    const apply = () => {
      if (drone && !beast) {
        if (drone.takeDamage(WEAPONS[p.weapon].damage)) {
          this.effects.explosion(drone.pos.clone(), 1.5);
          this.sfx.boom(0.5);
          this.hud.message("Дрон сбит!", 1.4, "#ffe14a");
        } else this.effects.impact(end, true);
        this.hud.hit(!drone.alive);
        return;
      }
      if (glassHit && !beast && !target) this.shatter(glassHit);
      if (!beast && !target && wHit?.hit) this.hitFenceFrom(wHit.pickedMesh);
      const racer = !beast && !target && wHit?.hit ? Race.racerOf(wHit.pickedMesh) : null;
      if (racer && this.race) {
        const killed = this.race.damage(racer, WEAPONS[p.weapon].damage);
        this.hud.hit(killed);
        this.effects.impact(end, true);
        if (killed) this.kills++;
        return;
      }
      if (p.weapon === "sticky") {
        if (beast && beast.alive) this.stick(beast.pos, () => (beast.stuckUntil = this.now + STICKY.stuckSec), beast.info.radius + 0.3, beast.info.name);
        else if (target && target.alive) {
          const tb = target;
          this.stick(tb.position, () => (tb.stuckUntil = this.now + STICKY.stuckSec), 0.6, "Враг");
          this.damageBot(tb, WEAPONS.sticky.damage);
        } else if (wHit?.hit) this.effects.impact(end, false);
        return;
      }
      if (beast && beast.alive) {
        const killed = beast.takeDamage(WEAPONS[p.weapon].damage, this.playerPrey, this.now);
        this.hud.hit(killed);
        if (killed) this.gainLeather(beast);
        this.effects.impact(end, true);
        return;
      }
      if (target && target.alive && Vector3.Distance(target.position.add(new Vector3(0, 1, 0)), end) < 2.2) {
        this.damageBot(target, computeDamage(p.weapon, p.clan, target.clan));
        this.effects.impact(end, true);
      } else if (wHit?.hit || target) {
        this.effects.impact(end, false);
      }
    };
    if (p.weapon === "clanWeapon") {
      this.effects.orb(muzzle, end, CLANS[p.clan].effect, 55, apply);
    } else if (p.weapon === "slingshot") {
      this.effects.orb(muzzle, end, "stone", 38, apply);
    } else if (p.weapon === "sticky") {
      this.effects.orb(muzzle, end, "goo", 30, apply);
    } else {
      this.effects.muzzleFlash(muzzle);
      this.effects.tracer(muzzle, end);
      apply();
    }

    // Вражеские боты рядом слышат выстрел
    for (const b of this.bots) {
      if (b.alive && this.foeOfPlayer(b) && Vector3.DistanceSquared(b.position, p.position) < 30 * 30) b.hear(p.position.clone());
    }
  }

  private damageBot(b: Bot, dmg: number): void {
    if (dmg <= 0) return;
    const killed = b.takeDamage(dmg, this.player.position.clone(), this.now);
    this.hud.hit(killed);
    if (killed) {
      this.kills++;
      this.teamKills[this.player.clan]++;
      this.sfx.kill();
      this.hud.message(`Враг повержен! (${this.kills})`, 1.4, "#ffe14a");
    } else {
      this.sfx.hit();
    }
  }

  // ---------------- Боты ----------------

  private isPlayerHidden(): boolean {
    const p = this.player;
    return p.crouching && this.now - p.lastShotAt > 1.5 && this.world.coverAt(p.position.x, p.position.z);
  }

  // ---------------- Правила матча: флаг, выбывание, время ----------------

  /** Клан выбыл: у всех ботов кончились жизни и игрок (если он из этого клана) тоже выбыл */
  private clanOut(c: ClanId): boolean {
    const botsOut = this.bots.filter((b) => b.clan === c && !b.guardHome).every((b) => !b.alive && b.lives <= 0);
    const playerOut = this.player.clan !== c || (!this.player.alive && this.player.lives <= 0);
    return botsOut && playerOut;
  }

  private endMatch(winner: ClanId | null, reason: string): void {
    if (this.state === "over") return;
    this.state = "over";
    if (this.scoped) this.setScoped(false);
    this.input.reset();
    this.onGameOver({ winner, reason, won: winner === this.player.clan, kills: this.kills });
  }

  private updateMatch(dt: number): void {
    if (this.race) {
      this.updateRace(dt);
      return;
    }
    // Время
    this.matchLeft -= dt;
    if (this.matchLeft <= 0) {
      const k = this.teamKills;
      if (k.dragons === k.snakes) this.endMatch(null, `Время вышло, ничья ${k.dragons}:${k.snakes}`);
      else {
        const w: ClanId = k.dragons > k.snakes ? "dragons" : "snakes";
        this.endMatch(w, `Время вышло. Счёт ${k.dragons}:${k.snakes}`);
      }
      return;
    }
    // «Каждый сам за себя»: остался последним — победа
    if (this.ffa) {
      if (this.bots.every((b) => !b.alive && b.lives <= 0)) {
        this.endMatch(this.player.clan, "Ты последний выживший в снегах!");
        return;
      }
    }
    // Выбывание целого клана
    for (const c of this.ffa ? [] : (["dragons", "snakes"] as const)) {
      if (this.clanOut(c)) {
        this.endMatch(enemyClan(c), `Все ${CLANS[c].name} выбыли`);
        return;
      }
    }
    // Захват флагов (на соло-уровне флагов нет — только перестрелка)
    for (const owner of this.world.level === 3 ? [] : (["dragons", "snakes"] as const)) {
      const base = this.world.bases[owner];
      const cap = this.capture[owner];
      const inZone = (t: Target) =>
        t.alive && (t.pos.x - base.flagPoint.x) ** 2 + (t.pos.z - base.flagPoint.z) ** 2 < RULES.flagRadius ** 2;
      const hitSince = (t: Target) =>
        t.bot ? t.bot.lastHitAt > cap.startedAt : this.player.lastDamageAt > cap.startedAt;
      if (cap.by && (!inZone(cap.by) || hitSince(cap.by))) {
        if (cap.by === this.playerTarget) this.hud.message("Захват сорван!", 1.5, "#ff6b5a");
        cap.by = null;
        cap.t = 0;
      }
      if (!cap.by) {
        const who = this.enemiesOf(owner).find(inZone);
        if (who) {
          cap.by = who;
          cap.t = 0;
          cap.startedAt = this.now;
          if (who === this.playerTarget) this.hud.message("Захват флага! Продержись 10 секунд", 2, "#ffe14a");
          else if (owner === this.player.clan) this.hud.message("Твой флаг захватывают! Защищай базу!", 2.5, "#ff6b5a");
          // Защитники рядом бросаются к базе
          for (const b of this.bots) if (b.clan === owner && b.alive) b.hear(base.flagPoint.clone());
        }
      }
      if (cap.by) {
        cap.t += dt / RULES.flagCaptureSec;
        if (cap.t >= 1) {
          this.endMatch(cap.by.clan!, `Флаг клана ${CLANS[owner].name} захвачен!`);
          return;
        }
      }
      // Флаг опускается по флагштоку вместе с захватом — видно издалека
      const want = 7.2 - 4.2 * cap.t;
      base.flag.position.y += (want - base.flag.position.y) * Math.min(1, dt * 8);
    }
  }

  private botContext(): BotContext {
    return {
      now: this.now,
      findTarget: (b) => this.findTarget(b),
      enemyHint: (b) => {
        const list = this.foesOf(b).filter((t) => t.alive);
        return list.length ? list[Math.floor(Math.random() * list.length)].pos : null;
      },
      randomWalkPoint: (near, radius) => this.world.randomWalkPoint(Math.random, near, radius),
      shoot: (b, t) => this.botShoot(b, t),
      throwBomb: (b, kind, t) => this.botThrow(b, kind, t),
      ground: (x, z) => this.world.heightAt(x, z),
      melee: (b, t) => {
        const dmg = b.guardHome ? 15 : 10;
        this.sfx.swing(0.6);
        if (t.animal) t.animal.takeDamage(dmg, this.preyOf(b), this.now);
        else if (t.bot) t.bot.takeDamage(dmg, b.position.clone(), this.now);
        else if (this.state === "playing") this.damagePlayer(dmg);
      },
      objective: (b) => {
        if (this.world.level === 3) return null;
        // Свой флаг захватывают — все бегут защищать; иначе штурмовики идут за чужим
        if (this.capture[b.clan].by) return this.world.bases[b.clan].flagPoint;
        return b.attacker ? this.world.bases[enemyClan(b.clan)].flagPoint : null;
      },
      basePoint: (clan) => {
        if (this.ffa) {
          // Возрождение в самом дальнем от игрока углу
          const sp = [...this.world.ffaSpawns].sort((a, b) => Vector3.DistanceSquared(b, this.player.position) - Vector3.DistanceSquared(a, this.player.position))[0];
          return { pos: sp, yaw: Math.atan2(-sp.x, -sp.z) };
        }
        const base = this.world.bases[clan];
        return { pos: base.spawns[Math.floor(Math.random() * base.spawns.length)], yaw: base.facing };
      },
    };
  }

  private targetOf(b: Bot): Target {
    let t = this.botTargets.get(b);
    if (!t) {
      t = {
        pos: b.position,
        get alive() {
          return b.alive;
        },
        clan: b.clan,
        bot: b,
      };
      this.botTargets.set(b, t);
    }
    return t;
  }

  /** Все возможные цели для клана: игрок (если он из другого клана) и чужие боты */
  /** Враги бота: в «каждый сам за себя» — все остальные, иначе — чужой клан */
  private foesOf(b: Bot): Target[] {
    if (!this.ffa) return this.enemiesOf(b.clan);
    const out: Target[] = [];
    if (this.state === "playing") out.push(this.playerTarget);
    for (const o of this.bots) if (o !== b) out.push(this.targetOf(o));
    return out;
  }

  private enemiesOf(clan: ClanId): Target[] {
    const out: Target[] = [];
    if (this.opts.clan !== clan && this.state === "playing") out.push(this.playerTarget);
    for (const o of this.bots) if (o.clan !== clan) out.push(this.targetOf(o));
    return out;
  }

  /** Ближайший видимый враг: проверяем лучом не больше трёх ближайших, чтобы не тратить кадр */
  private findTarget(b: Bot): Target | null {
    // Зверь, который бросился на этого бота, — первая цель: бот отстреливается
    const mine = this.preyOf(b);
    for (const a of this.animals) {
      if (a.alive && a.target === mine && Vector3.DistanceSquared(a.pos, b.position) < 25 * 25) return this.animalTarget(a);
    }
    const cands = this.foesOf(b)
      .filter((t) => t.alive)
      .map((t) => ({ t, d: Vector3.DistanceSquared(t.pos, b.position) }))
      .filter((c) => c.d < 55 * 55)
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    for (const { t } of cands) if (this.botCanSee(b, t)) return t;
    return null;
  }

  private botCanSee(b: Bot, t: Target): boolean {
    const p = this.player;
    const isPlayer = t === this.playerTarget;
    const to = t.pos.subtract(b.position);
    to.y = 0;
    const dist = to.length();
    if (dist > 55) return false;
    // Игрок сидит в укрытии и не стреляет — не виден (если не вплотную)
    if (isPlayer && this.isPlayerHidden() && dist > 3.5) return false;
    if (dist > 5) {
      const f = b.forward;
      const cos = (f.x * to.x + f.z * to.z) / dist;
      const fov = b.state === "chase" ? -0.2 : 0.35; // ~100° и ~70°
      if (cos < fov) return false;
    }
    const eye = b.eyePos;
    const heights = isPlayer ? [p.eyeHeight, p.crouching ? 0.6 : 1.1] : [1.5, 1.0];
    for (const h of heights) {
      const target = t.pos.add(new Vector3(0, h, 0));
      const dir = target.subtract(eye);
      const len = dir.length();
      dir.scaleInPlace(1 / len);
      const hit = this.scene.pickWithRay(new Ray(eye, dir, len), isWorldOrSoft, true);
      if (!hit?.hit) return true;
    }
    return false;
  }

  private botShoot(b: Bot, t: Target): void {
    const p = this.player;
    const w = WEAPONS[b.weapon];
    const origin = b.humanoid.getMuzzlePosition();
    const victim = t.bot;
    const beast = t.animal ?? null;
    const isPlayer = !victim && !beast;
    const crouch = isPlayer && p.crouching;
    const chest = t.pos.add(new Vector3(0, beast ? beast.info.height * 0.6 : crouch ? 0.7 : 1.15, 0));
    const toChest = chest.subtract(origin);
    const dist = toChest.length();
    const aim = toChest.scale(1 / dist);
    // Боты специально мажут: сильнее, если цель бежит или далеко; друг по другу — ещё сильнее, чтобы бой длился
    const speed = isPlayer ? p.speed : victim ? victim.speed : 3;
    const spread = (isPlayer ? 0.04 : 0.07) + (speed > 4 ? 0.05 : speed > 0.5 ? 0.025 : 0) + Math.min(0.03, dist * 0.0008);
    const dir = applySpread(aim, spread);
    const wHit = this.scene.pickWithRay(new Ray(origin, dir, w.range), isSolid, false);
    const glassHit = wHit?.hit && wHit.pickedMesh?.metadata?.kind === "glass" ? this.world.windowOf(wHit.pickedMesh) : undefined;
    let maxT = wHit?.hit ? wHit.distance : w.range;
    const top = isPlayer ? p.topHeight - 0.05 : beast ? beast.info.height : 1.62;
    const r = rayVsVerticalSegment(origin, dir, maxT, t.pos.x, t.pos.y + 0.15, t.pos.y + top, t.pos.z);
    const hit = r.dist < (beast ? beast.info.radius : 0.34) && r.t < maxT;
    if (hit) maxT = r.t;
    const end = origin.add(dir.scale(maxT));
    const vol = clamp(1 - Vector3.Distance(origin, p.position) / 70, 0.1, 0.8);
    this.sfx.shot(b.weapon, vol);

    const apply = () => {
      if (glassHit && !hit) this.shatter(glassHit);
      if (!hit && wHit?.hit) this.hitFenceFrom(wHit.pickedMesh);
      if (hit && t.alive && beast) {
        beast.takeDamage(WEAPONS[b.weapon].damage, this.preyOf(b), this.now);
        this.effects.impact(end, true);
      } else if (hit && t.alive) {
        const dmg = this.ffa ? WEAPONS[b.weapon].damage : computeDamage(b.weapon, b.clan, t.clan!);
        if (isPlayer) {
          if (this.state === "playing") this.damagePlayer(dmg);
        } else if (victim!.takeDamage(dmg, b.position.clone(), this.now)) {
          this.teamKills[b.clan]++;
        }
        this.effects.impact(end, true);
      } else if (wHit?.hit) {
        this.effects.impact(end, false);
      }
    };
    if (b.weapon === "clanWeapon") {
      this.effects.orb(origin, end, CLANS[b.clan].effect, 32, apply);
    } else if (b.weapon === "slingshot") {
      this.effects.orb(origin, end, "stone", 34, apply);
    } else {
      this.effects.tracer(origin, end, true);
      apply();
    }
  }

  private damagePlayer(dmg: number): void {
    if (dmg <= 0) return;
    const p = this.player;
    // Меч-щит гасит половину урона
    if (this.blocking) dmg = Math.round(dmg * (1 - MELEE.shieldBlock));
    const hpBefore = p.hp;
    const died = p.takeDamage(dmg, this.now);
    if (p.hp === hpBefore && !died) return; // неуязвим после возрождения
    this.hud.damage();
    this.sfx.hurt();
    if (died) {
      if (this.driving) this.exitCar();
      this.teamKills[enemyClan(p.clan)]++;
      this.state = "dead";
      this.deadTimer = 0;
      this.input.reset();
      if (p.lives <= 0) {
        p.humanoid.deathT = 1;
        p.humanoid.animate(0, 0, false, 0, false);
        if (this.race) this.endMatch(enemyClan(p.clan), "Твою машину разбили три раза — ты выбыл из гонки");
        else if (this.ffa) this.endMatch(enemyClan(p.clan), "Ты замёрз и выбыл. В снегах остались другие");
        else if (this.clanOut(p.clan)) this.endMatch(enemyClan(p.clan), `Все ${CLANS[p.clan].name} выбыли`);
        else this.endMatch(null, "Ты потратил все три жизни");
      } else {
        this.onDeath(p.lives);
      }
      // Чтобы видеть падение, временно показываем тело
      p.humanoid.setVisible(true);
    }
  }

  // ---------------- Сундуки с патронами ----------------

  private pickupChests(): void {
    const p = this.player;
    for (const c of this.chests) {
      if (!c.active) continue;
      const dx = c.pos.x - p.position.x;
      const dz = c.pos.z - p.position.z;
      if (dx * dx + dz * dz < 1.6 * 1.6 && p.position.y < 1.5) {
        c.active = false;
        c.mesh.setEnabled(false);
        c.respawnAt = this.now + RULES.chestRespawnSec;
        p.ammo = Math.min(RULES.maxAmmo, p.ammo + RULES.chestAmmo);
        this.sfx.pickup();
        // Рогатка «часто попадается в сундуках»: половина шансов, пока её нет
        const roll = this.rng();
        if (roll > 0.88 && this.bombs.boom < RULES.maxBombs) {
          this.bombs.boom++;
          this.hud.message("Взрывная бомба! (F)", 1.8, "#ffb347");
        } else if (roll > 0.82 && roll <= 0.88 && this.bombs.frost < RULES.maxBombs) {
          this.bombs.frost++;
          this.hud.message("Замораживающая бомба! (R)", 1.8, "#9fe8ff");
        } else if (this.bombs.weak < RULES.maxBombs && roll > 0.72) {
          this.bombs.weak++;
          this.hud.message("Лечебная бомба! (G)", 1.8, "#7dffb0");
        } else if (this.bombs.strong < RULES.maxBombs && roll > 0.62 && roll <= 0.72) {
          this.bombs.strong++;
          this.hud.message("Сильная лечебная бомба! (H)", 1.8, "#7dffb0");
        } else if (p.swordLevel < 2 && roll < 0.15) {
          p.swordLevel = 2;
          p.humanoid.setSwordLevel(2);
          this.setVmSwordLevel(2);
          this.hud.message(`${SWORDS[p.clan][1].name}! Меч стал сильнее`, 2.2, "#ffe14a");
        } else if (!p.owned.has("slingshot") && this.rng() < 0.5) {
          p.owned.add("slingshot");
          this.hud.message(this.input.isTouch ? "Нашёл рогатку! Кнопка «Оружие»" : "Нашёл рогатку! Клавиша 4", 2.2, "#ffe14a");
        } else {
          this.hud.message(`+${RULES.chestAmmo} патронов`, 1.2, "#ffb347");
        }
      }
    }
  }

  private updateChests(): void {
    const bob = Math.sin(this.now * 2) * 0.06;
    for (const c of this.chests) {
      if (!c.active && this.now >= c.respawnAt) {
        c.active = true;
        c.mesh.setEnabled(true);
        this.relocate(c);
      }
      if (c.active) {
        c.mesh.position.y = c.pos.y + 0.32 + bob;
        c.mesh.rotation.y = this.now * 0.8;
      }
    }
  }

  /** Уровень 3: ресурс появляется снова, но в другом случайном месте */
  private relocate(c: AmmoChest, lift = 0.3): void {
    if (this.world.level !== 3) return;
    const p = this.world.randomWalkPoint(Math.random);
    c.pos.set(p.x, this.world.heightAt(p.x, p.z), p.z);
    c.mesh.position.set(p.x, c.pos.y + lift, p.z);
  }

  // ---------------- Служебное ----------------

  setPaused(v: boolean): void {
    this.paused = v;
    if (v) this.input.reset();
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
