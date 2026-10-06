import {
  PhotoDome,
  StandardMaterial,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  InstancedMesh,
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
  SWORDS,
  WEAPONS,
  computeDamage,
  enemyClan,
  type ClanId,
  type WeaponId,
} from "@clan-battle/shared";
import { Animal, type Prey } from "./animals";
import { Birds } from "./birds";
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
  /** За рулём какой машины (или null) */
  driving: { mesh: Mesh; yaw: number; home: Vector3; homeYaw: number; speed?: number } | null = null;
  private carSpeed = 0;
  private ramCooldown = new Map<object, number>();
  /** Замах мечом: когда начали держать кнопку (или -1) */
  private chargeFrom = -1;
  /** Держим меч ровно, как щит */
  blocking = false;
  /** Лечебные бомбы в запасе */
  bombs = { weak: 1, strong: 0, boom: 1, frost: 1 };
  /** Летящие боевые бомбы */
  private thrown: { mesh: Mesh; pos: Vector3; vel: Vector3; kind: "boom" | "frost"; clan: ClanId }[] = [];
  /** Игрока заморозили вражеской бомбой */
  private playerFrozenUntil = -1;
  /** Ледяные глыбы вокруг замороженных */
  private ice: { mesh: Mesh; until: number; follow: Vector3 }[] = [];
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
    g.build();
    return g;
  }

  private sun!: DirectionalLight;

  private build(): void {
    const { scene, opts, sun } = this;
    // На телефонах и в режиме ?low мелких деталей (трава, цветы) втрое меньше
    this.world = new World(scene, opts.detail);
    this.effects = new Effects(scene, opts.lowFx || opts.touch);
    this.player = new Player(scene, opts.clan);
    this.hud = new Hud(opts.clan);
    this.hud.onSlotTap((i) => this.player.selectWeapon(i));

    // Команды 5 на 5: сначала враги (botCount), потом союзники — на одного меньше, ведь игрок тоже в команде
    const enemy = enemyClan(opts.clan);
    for (let i = 0; i < opts.botCount; i++) {
      this.bots.push(new Bot(scene, enemy, BOT_WEAPONS[i % BOT_WEAPONS.length]));
    }
    for (let i = 0; i < opts.botCount - 1; i++) {
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
    this.birds = new Birds(this.scene, opts.detail < 1 ? 6 : 12);

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
      inst.position.set(p.x, 0.3, p.z);
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
    const zones: [number, number, number, number][] = [
      [-40, -20, 40, 20],
      [-60, 20, -15, 60],
      [15, -60, 60, -15],
      [-60, -60, -20, -20],
      [20, 20, 60, 60],
      [-20, -40, 20, -15],
      [-20, 20, 20, 45],
      [-40, -20, 40, 20],
    ];
    zones.forEach(([x0, z0, x1, z1], i) => {
      for (let k = 0; k < 40; k++) {
        const x = x0 + rnd() * (x1 - x0);
        const z = z0 + rnd() * (z1 - z0);
        if (!this.world.isWalkable(x, z)) continue;
        const inst = med.createInstance(`medkit${i}`);
        inst.position.set(x, 0.24, z);
        inst.isPickable = false;
        this.medkits.push({ mesh: inst, pos: new Vector3(x, 0, z), active: true, respawnAt: 0 });
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
    const near = !!this.driving || !!this.nearestCar();
    document.body.classList.toggle("near-car", near && this.state === "playing");
    const hint = document.getElementById("car-hint");
    if (hint) hint.textContent = this.driving ? "E — выйти из машины" : "E — сесть в машину";
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
    this.carSpeed = clamp(this.carSpeed, -5, 14);
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
    car.mesh.position.y = 0;
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
      for (const b of this.bots) if (b.alive && b.clan !== p.clan) ram(b.position, b, (d) => this.damageBot(b, d));
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
    for (const b of this.bots) if (b.alive && b.clan !== p.clan) consider(b.position, 0, { bot: b });
    for (const a of this.animals) if (a.alive) consider(a.pos, a.info.radius, { beast: a });
    const hit = best as { d: number; bot?: Bot; beast?: Animal } | null;
    if (!hit) return;
    this.sfx.clang();
    if (hit.bot) {
      this.damageBot(hit.bot, dmg);
      this.effects.impact(hit.bot.position.add(new Vector3(0, 1.2, 0)), true);
    } else if (hit.beast) {
      const killed = hit.beast.takeDamage(dmg, this.playerPrey, this.now);
      this.hud.hit(killed);
      if (killed) this.hud.message(`${hit.beast.info.name} повержен`, 1.4, "#ffe14a");
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
      c.mesh.position.set(c.follow.x, c.follow.y + 0.95, c.follow.z);
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
    const place: [Animal["kind"], number, number][] = [
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
    for (const a of this.animals) a.update(dt, this.now, prey, walkPoint, walkable);
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
    this.player.owned.delete("slingshot");
    this.player.swordLevel = 1;
    this.player.humanoid.setSwordLevel(1);
    this.setVmSwordLevel(1);
    this.chargeFrom = -1;
    this.bombs = { weak: 1, strong: 0, boom: 1, frost: 1 };
    this.playerFrozenUntil = -1;
    for (const t of this.thrown) t.mesh.dispose();
    this.thrown = [];
    for (const c of this.ice) c.mesh.dispose();
    this.ice = [];
    this.removeDome();
    this.player.selectWeapon(0);
    this.respawnPlayer();
    this.bots.forEach((b, i) => {
      const base = this.world.bases[b.clan];
      const sp = base.spawns[i % base.spawns.length];
      b.lives = RULES.lives;
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
  }

  private respawnPlayer(): void {
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
    if (input.scopeToggle && this.state === "playing") this.setScoped(!this.scoped);
    if (this.state !== "playing" && this.scoped) this.setScoped(false);
    const sword = p.weapon === "sword";
    // С мечом правая кнопка — щит, а не прицел
    this.blocking = sword && input.aim && !this.scoped && this.state === "playing";
    this.aiming = !sword && input.aim && !this.scoped && this.state === "playing";
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
      if (input.use) this.toggleCar();
      if (this.driving) this.updateCar(dt);
      else p.update(dt, input, this.now, () => this.canStand(), (x, z, y) => this.world.floorAt(x, z, y));
      this.updateCarHint();
      if (this.driving) {
        if (input.fire && !this.prevFire) this.hud.message("Из машины не стреляют — выйди (E)", 1.2, "#ffb347");
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
    this.updateDome(dt);
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
      owned: [...p.owned],
      swordLevel: p.swordLevel,
      bombs: this.bombs,
      domeLeft: this.dome ? Math.max(0, this.dome.until - this.now) : 0,
      timeLeft: this.matchLeft,
      capture: this.captureInfo(),
    });
    input.endFrame();
  }

  /** Полоска захвата для HUD: важнее всего захват своего флага */
  private captureInfo(): { text: string; t: number; color: string } | null {
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
    for (const b of this.bots) if (b.alive) n[b.clan]++;
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
      if (!b.alive || b.clan === p.clan) continue;
      const bp = b.position;
      const r = rayVsVerticalSegment(origin, dir, maxT, bp.x, bp.y + 0.2, bp.y + 1.62, bp.z);
      if (r.dist < 0.36 && r.t < maxT) {
        maxT = r.t;
        target = b;
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
      if (glassHit && !beast && !target) this.shatter(glassHit);
      if (beast && beast.alive) {
        const killed = beast.takeDamage(WEAPONS[p.weapon].damage, this.playerPrey, this.now);
        this.hud.hit(killed);
        if (killed) this.hud.message(`${beast.info.name} повержен`, 1.4, "#ffe14a");
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
    } else {
      this.effects.muzzleFlash(muzzle);
      this.effects.tracer(muzzle, end);
      apply();
    }

    // Вражеские боты рядом слышат выстрел
    for (const b of this.bots) {
      if (b.alive && b.clan !== p.clan && Vector3.DistanceSquared(b.position, p.position) < 30 * 30) b.hear(p.position.clone());
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
    const botsOut = this.bots.filter((b) => b.clan === c).every((b) => !b.alive && b.lives <= 0);
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
    // Выбывание целого клана
    for (const c of ["dragons", "snakes"] as const) {
      if (this.clanOut(c)) {
        this.endMatch(enemyClan(c), `Все ${CLANS[c].name} выбыли`);
        return;
      }
    }
    // Захват флагов
    for (const owner of ["dragons", "snakes"] as const) {
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
        const list = this.enemiesOf(b.clan).filter((t) => t.alive);
        return list.length ? list[Math.floor(Math.random() * list.length)].pos : null;
      },
      randomWalkPoint: (near, radius) => this.world.randomWalkPoint(Math.random, near, radius),
      shoot: (b, t) => this.botShoot(b, t),
      throwBomb: (b, kind, t) => this.botThrow(b, kind, t),
      melee: (b, t) => {
        const dmg = 10;
        this.sfx.swing(0.6);
        if (t.animal) t.animal.takeDamage(dmg, this.preyOf(b), this.now);
        else if (t.bot) t.bot.takeDamage(dmg, b.position.clone(), this.now);
        else if (this.state === "playing") this.damagePlayer(dmg);
      },
      objective: (b) => {
        // Свой флаг захватывают — все бегут защищать; иначе штурмовики идут за чужим
        if (this.capture[b.clan].by) return this.world.bases[b.clan].flagPoint;
        return b.attacker ? this.world.bases[enemyClan(b.clan)].flagPoint : null;
      },
      basePoint: (clan) => {
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
    const cands = this.enemiesOf(b.clan)
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
      if (hit && t.alive && beast) {
        beast.takeDamage(WEAPONS[b.weapon].damage, this.preyOf(b), this.now);
        this.effects.impact(end, true);
      } else if (hit && t.alive) {
        const dmg = computeDamage(b.weapon, b.clan, t.clan!);
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
        if (this.clanOut(p.clan)) this.endMatch(enemyClan(p.clan), `Все ${CLANS[p.clan].name} выбыли`);
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
      }
      if (c.active) {
        c.mesh.position.y = 0.32 + bob;
        c.mesh.rotation.y = this.now * 0.8;
      }
    }
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
