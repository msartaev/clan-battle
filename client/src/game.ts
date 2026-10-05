import {
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
  RULES,
  WEAPONS,
  computeDamage,
  enemyClan,
  type ClanId,
  type WeaponId,
} from "@clan-battle/shared";
import { Bot, type BotContext } from "./bot";
import { Effects, Sfx } from "./effects";
import { Hud } from "./hud";
import { flatMat } from "./humanoid";
import { getModels, gunKey, loadModels } from "./models";
import type { Input } from "./input";
import { Player } from "./player";
import { applySpread, clamp, dirFromYawPitch, makeRng, rayVsVerticalSegment } from "./utils";
import { World } from "./world";

export interface GameOptions {
  clan: ClanId;
  touch: boolean;
  /** Слабое устройство: без теней, меньше частиц, ниже разрешение */
  lowFx: boolean;
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

const BOT_WEAPONS: WeaponId[] = ["weakPistol", "weakPistol", "strongPistol", "weakPistol", "clanWeapon", "weakPistol", "strongPistol", "clanWeapon"];

const isWorld = (m: AbstractMesh) => m.metadata?.kind === "world";
const isWorldOrSoft = (m: AbstractMesh) => m.metadata?.kind === "world" || m.metadata?.kind === "soft";

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
  private rng = makeRng(7);
  private emptyWarnAt = 0;
  onGameOver: (kills: number) => void = () => undefined;
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
    this.engine.setHardwareScalingLevel(opts.touch ? Math.max(1, dpr / 1.25) * 1.15 : 1);

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
    this.camera.fov = 1.05;
    this.camera.inputs.clear();
    scene.activeCamera = this.camera;
    this.sun = sun;
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
    this.world = new World(scene);
    this.effects = new Effects(scene, opts.lowFx || opts.touch);
    this.player = new Player(scene, opts.clan);
    this.hud = new Hud(opts.clan);
    this.hud.onSlotTap((i) => this.player.selectWeapon(i));

    // Боты вражеского клана
    const enemy = enemyClan(opts.clan);
    for (let i = 0; i < opts.botCount; i++) {
      this.bots.push(new Bot(scene, enemy, BOT_WEAPONS[i % BOT_WEAPONS.length]));
    }

    // Вид от первого лица: руки с оружием прикреплены к камере
    this.viewmodel = new TransformNode("viewmodel", scene);
    this.viewmodel.parent = this.camera;
    this.vmMuzzle = this.buildViewmodel();

    this.buildChests();

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
        const gi = models.guns[gunKey(id, this.opts.clan)].instantiateModelsToScene((n) => `vm_${id}_${n}`, false, {
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

  // ---------------- Матч ----------------

  resetMatch(): void {
    this.now = 0;
    this.kills = 0;
    this.state = "playing";
    this.deadTimer = 0;
    this.player.lives = RULES.lives;
    this.player.selectWeapon(0);
    this.respawnPlayer();
    const enemy = enemyClan(this.opts.clan);
    this.bots.forEach((b, i) => {
      const base = this.world.bases[enemy];
      const sp = base.spawns[i % base.spawns.length];
      b.spawn(sp, base.facing);
    });
    for (const c of this.chests) {
      c.active = true;
      c.mesh.setEnabled(true);
    }
    this.effects.clearOrbs();
    this.hud.reset();
    this.input.reset();
  }

  private respawnPlayer(): void {
    const base = this.world.bases[this.opts.clan];
    const sp = base.spawns[Math.floor(this.rng() * base.spawns.length)];
    this.player.spawnAt(sp, base.facing, this.now);
    this.state = "playing";
    // После смерти тело было видно — в 1-м лице снова прячем
    this.setFirstPerson(this.firstPerson);
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

    if (input.cameraToggle) this.setFirstPerson(!this.firstPerson);
    if (input.weaponSelect !== null) p.selectWeapon(input.weaponSelect);
    if (input.weaponCycle) p.cycleWeapon(input.weaponCycle);
    this.updateViewmodelWeapon();

    if (this.state === "playing") {
      p.update(dt, input, this.now, () => this.canStand());
      if (input.fire) this.tryShoot(!this.prevFire);
      this.prevFire = input.fire;
      this.pickupChests();
    } else {
      this.prevFire = false;
      if (this.state === "dead") {
        this.deadTimer += dt;
        p.humanoid.deathT = clamp(this.deadTimer / 0.5, 0, 1);
        p.humanoid.animate(dt, 0, false, 0, false);
        if (this.deadTimer >= RULES.playerRespawnSec) {
          this.respawnPlayer();
          this.onRespawn();
        }
      }
    }

    const ctx = this.botContext();
    for (const b of this.bots) b.update(dt, ctx);

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
      status: p.crouching ? "Присел" : p.sprinting ? "Бег" : "",
      hidden,
    });
    input.endFrame();
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
    if (this.firstPerson && this.state !== "dead") {
      cam.position.copyFrom(eye);
      // Покачивание оружия при ходьбе и отдача
      this.vmKick = Math.max(0, this.vmKick - dt * 10);
      const bob = p.speed > 0.5 && p.grounded ? Math.sin(this.now * (p.sprinting ? 13 : 9)) * 0.012 : 0;
      this.viewmodel.position.set(0.22, -0.2 + bob - (p.crouching ? 0.01 : 0), 0.42 - this.vmKick * 0.06);
      this.viewmodel.rotation.x = -this.vmKick * 0.15;
      return;
    }
    // Третье лицо: камера за правым плечом, не проходит сквозь стены
    const fwd = dirFromYawPitch(p.yaw, p.pitch);
    const right = new Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const pivot = eye.add(right.scale(0.75)).add(new Vector3(0, 0.15, 0));
    const back = fwd.scale(-1);
    const ray = new Ray(pivot, back, this.camDist + 0.3);
    const hit = this.scene.pickWithRay(ray, isWorld, false);
    let d = this.camDist;
    if (hit?.hit && hit.distance < d + 0.3) d = Math.max(0.3, hit.distance - 0.3);
    const target = pivot.add(back.scale(d));
    // Камера не уходит под землю
    target.y = Math.max(target.y, 0.3);
    cam.position.copyFrom(target);
  }

  // ---------------- Стрельба игрока ----------------

  private tryShoot(fresh: boolean): void {
    const p = this.player;
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
    const spreadK = (p.crouching ? 0.6 : 1) * (p.speed > 4 ? 1.8 : p.speed > 0.5 ? 1.25 : 1) * (p.grounded ? 1 : 2);
    const dir = applySpread(aimDir, w.spread * spreadK);
    // В 3-м лице луч начинается у игрока, а не у камеры
    const origin = this.firstPerson
      ? cam.position.clone()
      : cam.position.add(aimDir.scale(Vector3.Distance(cam.position, p.position.add(new Vector3(0, p.eyeHeight, 0))) * 0.9));

    const wHit = this.scene.pickWithRay(new Ray(origin, dir, w.range), isWorld, false);
    let maxT = wHit?.hit ? wHit.distance : w.range;
    let target: Bot | null = null;
    for (const b of this.bots) {
      if (!b.alive) continue;
      const bp = b.position;
      const r = rayVsVerticalSegment(origin, dir, maxT, bp.x, bp.y + 0.2, bp.y + 1.62, bp.z);
      if (r.dist < 0.36 && r.t < maxT) {
        maxT = r.t;
        target = b;
      }
    }
    const end = origin.add(dir.scale(maxT));
    const muzzle = this.firstPerson ? this.vmMuzzle.getAbsolutePosition().clone() : p.humanoid.getMuzzlePosition();
    this.vmKick = 1;
    p.pitch -= p.weapon === "strongPistol" ? 0.018 : 0.006;

    const apply = () => {
      if (target && target.alive && Vector3.Distance(target.position.add(new Vector3(0, 1, 0)), end) < 2.2) {
        this.damageBot(target, computeDamage(p.weapon, p.clan, target.clan));
        this.effects.impact(end, true);
      } else if (wHit?.hit || target) {
        this.effects.impact(end, false);
      }
    };
    if (p.weapon === "clanWeapon") {
      this.effects.orb(muzzle, end, CLANS[p.clan].effect, 55, apply);
    } else {
      this.effects.muzzleFlash(muzzle);
      this.effects.tracer(muzzle, end);
      apply();
    }

    // Боты рядом слышат выстрел
    for (const b of this.bots) {
      if (b.alive && Vector3.DistanceSquared(b.position, p.position) < 30 * 30) b.hear(p.position.clone());
    }
  }

  private damageBot(b: Bot, dmg: number): void {
    if (dmg <= 0) return;
    const killed = b.takeDamage(dmg, this.player.position.clone(), this.now);
    this.hud.hit(killed);
    if (killed) {
      this.kills++;
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

  private botContext(): BotContext {
    const p = this.player;
    return {
      now: this.now,
      playerPos: p.position,
      playerAlive: this.state === "playing" && p.alive,
      canSee: (b) => this.botCanSee(b),
      randomWalkPoint: (near, radius) => this.world.randomWalkPoint(Math.random, near, radius),
      shoot: (b, t) => this.botShoot(b, t),
      basePoint: (clan) => {
        const base = this.world.bases[clan];
        return { pos: base.spawns[Math.floor(Math.random() * base.spawns.length)], yaw: base.facing };
      },
    };
  }

  private botCanSee(b: Bot): boolean {
    const p = this.player;
    const to = p.position.subtract(b.position);
    to.y = 0;
    const dist = to.length();
    if (dist > 55) return false;
    // Сидит в укрытии и не стреляет — не виден (если не вплотную)
    if (this.isPlayerHidden() && dist > 3.5) return false;
    if (dist > 5) {
      const f = b.forward;
      const cos = (f.x * to.x + f.z * to.z) / dist;
      const fov = b.state === "chase" ? -0.2 : 0.35; // ~100° и ~70°
      if (cos < fov) return false;
    }
    const eye = b.eyePos;
    for (const h of [p.eyeHeight, p.crouching ? 0.6 : 1.1]) {
      const target = p.position.add(new Vector3(0, h, 0));
      const dir = target.subtract(eye);
      const len = dir.length();
      dir.scaleInPlace(1 / len);
      const hit = this.scene.pickWithRay(new Ray(eye, dir, len), isWorldOrSoft, true);
      if (!hit?.hit) return true;
    }
    return false;
  }

  private botShoot(b: Bot, _target: Vector3): void {
    const p = this.player;
    const w = WEAPONS[b.weapon];
    const origin = b.humanoid.getMuzzlePosition();
    const chest = p.position.add(new Vector3(0, p.crouching ? 0.7 : 1.15, 0));
    const toChest = chest.subtract(origin);
    const dist = toChest.length();
    const aim = toChest.scale(1 / dist);
    // Боты специально мажут: сильнее, если игрок бежит или далеко
    const spread = 0.04 + (p.speed > 4 ? 0.05 : p.speed > 0.5 ? 0.025 : 0) + Math.min(0.03, dist * 0.0008);
    const dir = applySpread(aim, spread);
    const wHit = this.scene.pickWithRay(new Ray(origin, dir, w.range), isWorld, false);
    let maxT = wHit?.hit ? wHit.distance : w.range;
    const r = rayVsVerticalSegment(origin, dir, maxT, p.position.x, p.position.y + 0.15, p.position.y + p.topHeight - 0.05, p.position.z);
    const hitPlayer = r.dist < 0.34 && r.t < maxT;
    if (hitPlayer) maxT = r.t;
    const end = origin.add(dir.scale(maxT));
    const vol = clamp(1 - dist / 70, 0.15, 0.8);
    this.sfx.shot(b.weapon, vol);

    const apply = () => {
      if (hitPlayer && this.state === "playing") {
        this.damagePlayer(computeDamage(b.weapon, b.clan, p.clan));
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
    const hpBefore = p.hp;
    const died = p.takeDamage(dmg, this.now);
    if (p.hp === hpBefore && !died) return; // неуязвим после возрождения
    this.hud.damage();
    this.sfx.hurt();
    if (died) {
      this.state = "dead";
      this.deadTimer = 0;
      this.input.reset();
      if (p.lives <= 0) {
        this.state = "over";
        p.humanoid.deathT = 1;
        p.humanoid.animate(0, 0, false, 0, false);
        this.onGameOver(this.kills);
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
        this.hud.message(`+${RULES.chestAmmo} патронов`, 1.2, "#ffb347");
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
