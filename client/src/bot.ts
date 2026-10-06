import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { CLANS, RULES, WEAPONS, type ClanId, type WeaponId } from "@clan-battle/shared";
import type { Animal } from "./animals";
import { Humanoid, randomLook } from "./humanoid";
import { angleDiff, clamp } from "./utils";

export type BotState = "wander" | "chase" | "search" | "dead";

/** Цель бота: игрок или бот другого клана. pos — живая ссылка на позицию */
export interface Target {
  pos: Vector3;
  readonly alive: boolean;
  /** null — зверь */
  clan: ClanId | null;
  bot: Bot | null;
  animal?: Animal | null;
}

/** То, что бот знает о мире (даёт Game) */
export interface BotContext {
  now: number;
  /** Ближайший враг, которого бот видит прямо сейчас (с учётом стен, кустов и скрытности) */
  findTarget(bot: Bot): Target | null;
  /** Где примерно враги — чтобы бродить в их сторону */
  enemyHint(bot: Bot): Vector3 | null;
  randomWalkPoint(near?: Vector3, radius?: number): Vector3;
  shoot(bot: Bot, target: Target): void;
  basePoint(clan: ClanId): { pos: Vector3; yaw: number };
  /** Куда идти «по заданию»: штурмовикам — к вражескому флагу; null — просто бродить */
  objective(bot: Bot): Vector3 | null;
}

let botCounter = 0;

export class Bot {
  readonly id: number;
  readonly collider: Mesh;
  readonly humanoid: Humanoid;
  readonly weapon: WeaponId;
  hp: number = RULES.maxHp;
  lives: number = RULES.lives;
  /** Когда последний раз ранили — захват флага сбрасывается */
  lastHitAt = -999;
  /** Заморожен бомбой до этого момента: не ходит и не стреляет */
  frozenUntil = -1;
  /** Штурмовик: в свободное время идёт захватывать вражеский флаг */
  attacker = false;
  state: BotState = "wander";
  yaw = 0;
  aimPitch = 0;
  speed = 0;
  private goal = new Vector3();
  private target: Target | null = null;
  private lastSeen = new Vector3();
  private seeCheckIn = 0;
  private sees = false;
  private reactionLeft = 0;
  private shotCooldown = 0;
  private burstLeft = 3;
  private strafeDir = 1;
  private strafeTimer = 0;
  private searchTimer = 0;
  private stuckTimer = 0;
  private stuckPos = new Vector3();
  private dodgeTimer = 0;
  private dodgeDir = new Vector3();
  private deadTimer = 0;
  private hpBar: Mesh;
  private hpBarBg: Mesh;
  private hpBarShowUntil = 0;

  /** Метка над головой союзника */
  private allyMark: Mesh | null = null;

  constructor(scene: Scene, readonly clan: ClanId, weapon: WeaponId, readonly friendly = false) {
    this.id = ++botCounter;
    this.weapon = weapon;
    this.collider = MeshBuilder.CreateBox(`botCollider${this.id}`, { size: 0.5 }, scene);
    this.collider.isVisible = false;
    this.collider.isPickable = false;
    this.collider.checkCollisions = true;
    this.collider.ellipsoid = new Vector3(0.35, 0.9, 0.35);
    this.collider.ellipsoidOffset = new Vector3(0, 0.9, 0);
    this.humanoid = new Humanoid(scene, `bot${this.id}`, randomLook(clan));
    this.humanoid.setWeapon(weapon);

    // Полоска здоровья над головой (видна после попадания)
    const bgMat = new StandardMaterial(`hpbg${this.id}`, scene);
    bgMat.emissiveColor = new Color3(0.1, 0.1, 0.1);
    bgMat.disableLighting = true;
    const fgMat = new StandardMaterial(`hpfg${this.id}`, scene);
    fgMat.emissiveColor = new Color3(1, 0.25, 0.2);
    fgMat.disableLighting = true;
    this.hpBarBg = MeshBuilder.CreatePlane(`hpBg${this.id}`, { width: 0.8, height: 0.1 }, scene);
    this.hpBarBg.material = bgMat;
    this.hpBarBg.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.hpBarBg.isPickable = false;
    this.hpBar = MeshBuilder.CreatePlane(`hpFg${this.id}`, { width: 0.76, height: 0.06 }, scene);
    this.hpBar.material = fgMat;
    this.hpBar.parent = this.hpBarBg;
    this.hpBar.position.z = -0.01;
    this.hpBar.isPickable = false;
    this.hpBarBg.setEnabled(false);

    if (friendly) {
      // Свои отмечены ромбиком цвета клана — чтобы не путать с врагами издалека
      const mark = MeshBuilder.CreateDisc(`ally${this.id}`, { radius: 0.18, tessellation: 4 }, scene);
      const mm = new StandardMaterial(`allyMat${this.id}`, scene);
      mm.emissiveColor = Color3.FromHexString(CLANS[clan].color);
      mm.disableLighting = true;
      mark.material = mm;
      mark.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mark.isPickable = false;
      this.allyMark = mark;
    }
  }

  get position(): Vector3 {
    return this.collider.position;
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  spawn(pos: Vector3, yaw: number): void {
    this.collider.position.copyFrom(pos);
    this.collider.position.y = 0;
    this.collider.checkCollisions = true;
    this.yaw = yaw;
    this.hp = RULES.maxHp;
    this.state = "wander";
    this.goal.copyFrom(pos);
    this.sees = false;
    this.target = null;
    this.seeCheckIn = Math.random() * 0.2;
    this.humanoid.deathT = 0;
    this.humanoid.setEnabled(true);
    this.hpBarBg.setEnabled(false);
    this.stuckPos.copyFrom(pos);
    this.stuckTimer = 0;
    this.syncHumanoid(0);
  }

  /** Возвращает true, если бот погиб */
  takeDamage(amount: number, from: Vector3, now: number): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.lastHitAt = now;
    this.hpBarShowUntil = now + 4;
    if (this.hp <= 0) {
      this.state = "dead";
      this.lives -= 1;
      this.deadTimer = 0;
      this.collider.checkCollisions = false;
      this.hpBarBg.setEnabled(false);
      return true;
    }
    // Получил урон — разворачивается к стрелку и ищет его
    if (this.state !== "chase") {
      this.state = "search";
      this.lastSeen.copyFrom(from);
      this.searchTimer = 6;
    }
    this.reactionLeft = Math.min(this.reactionLeft, 0.25);
    return false;
  }

  /** Услышал выстрел */
  hear(pos: Vector3): void {
    if (this.state === "wander") {
      this.state = "search";
      this.lastSeen.copyFrom(pos);
      this.searchTimer = 6;
    }
  }

  get eyePos(): Vector3 {
    return this.collider.position.add(new Vector3(0, 1.62, 0));
  }

  /** Направление взгляда (горизонтальное) */
  get forward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  update(dt: number, ctx: BotContext): void {
    if (this.state === "dead") {
      this.deadTimer += dt;
      this.humanoid.deathT = clamp(this.deadTimer / 1.1, 0, 1);
      this.humanoid.animate(dt, 0, false, 0, false);
      if (this.deadTimer > 2.2) this.humanoid.setEnabled(false);
      this.allyMark?.setEnabled(false);
      // Три жизни, как у игрока: после последней — выбыл до конца матча
      if (this.deadTimer > RULES.botRespawnSec && this.lives > 0) {
        const b = ctx.basePoint(this.clan);
        this.spawn(b.pos, b.yaw);
      }
      return;
    }

    // Заморожен: стоит ледяной статуей
    if (ctx.now < this.frozenUntil) {
      this.speed = 0;
      this.humanoid.animate(dt, 0, false, this.aimPitch, false);
      return;
    }

    // Зрение — несколько раз в секунду, не каждый кадр
    this.seeCheckIn -= dt;
    if (this.seeCheckIn <= 0) {
      this.seeCheckIn = 0.18 + Math.random() * 0.06;
      const was = this.sees;
      const t = ctx.findTarget(this);
      this.sees = !!t;
      if (t) {
        if (!was || t !== this.target) this.reactionLeft = 0.45 + Math.random() * 0.5;
        this.target = t;
        this.state = "chase";
        this.lastSeen.copyFrom(t.pos);
      } else if (was && this.state === "chase") {
        this.state = "search";
        this.searchTimer = 7;
      }
    }
    if (this.target && !this.target.alive) {
      this.target = null;
      this.sees = false;
      if (this.state !== "wander") this.state = "wander";
    }

    let move = Vector3.Zero();
    let moveSpeed = 0;
    let faceTarget: Vector3 | null = null;
    const pos = this.collider.position;

    const obj = this.state === "wander" ? ctx.objective(this) : null;
    if (obj) {
      // Задание: дойти до зоны захвата и стоять в ней, оглядываясь
      const d2 = Vector3.DistanceSquared(pos, obj);
      if (d2 > (RULES.flagRadius - 1.2) ** 2) {
        if (Vector3.DistanceSquared(this.goal, obj) > 4) this.goal = obj.clone();
        move = this.goal.subtract(pos);
        moveSpeed = 3.6;
        faceTarget = this.goal;
      } else {
        this.yaw += dt * 0.8;
      }
    } else if (this.state === "wander") {
      if (Vector3.DistanceSquared(pos, this.goal) < 2.5) {
        // Чаще бродят в сторону врагов, чтобы было с кем сражаться
        const hint = Math.random() < 0.6 ? ctx.enemyHint(this) : null;
        this.goal = hint ? ctx.randomWalkPoint(hint, 24) : ctx.randomWalkPoint();
      }
      move = this.goal.subtract(pos);
      moveSpeed = 2.6;
      faceTarget = this.goal;
    } else if (this.state === "search") {
      this.searchTimer -= dt;
      move = this.lastSeen.subtract(pos);
      moveSpeed = 3.6;
      faceTarget = this.lastSeen;
      if (this.searchTimer <= 0 || move.lengthSquared() < 2) {
        this.state = "wander";
        this.goal = ctx.randomWalkPoint(pos, 20);
      }
    } else if (this.state === "chase" && this.target) {
      const tPos = this.target.pos;
      const toP = tPos.subtract(pos);
      toP.y = 0;
      const dist = toP.length();
      faceTarget = tPos;
      const dirP = toP.scale(1 / Math.max(dist, 0.001));
      const side = new Vector3(dirP.z, 0, -dirP.x).scale(this.strafeDir);
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 1 + Math.random() * 1.5;
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      }
      if (dist > 16 || !this.sees) {
        move = dirP.add(side.scale(0.3));
        moveSpeed = 4.2;
      } else if (dist < 6) {
        move = dirP.scale(-1).add(side.scale(0.5));
        moveSpeed = 3;
      } else {
        move = side.add(dirP.scale(0.15));
        moveSpeed = 2.4;
      }

      // Стрельба
      if (this.sees) {
        this.reactionLeft -= dt;
        this.shotCooldown -= dt;
        const facingErr = Math.abs(angleDiff(this.yaw, Math.atan2(toP.x, toP.z)));
        if (this.reactionLeft <= 0 && this.shotCooldown <= 0 && facingErr < 0.35 && dist < WEAPONS[this.weapon].range) {
          ctx.shoot(this, this.target);
          this.burstLeft -= 1;
          const rate = this.weapon === "weakPistol" ? 3 : this.weapon === "strongPistol" ? 1.1 : 0.8;
          this.shotCooldown = 1 / rate;
          if (this.burstLeft <= 0) {
            this.burstLeft = 2 + Math.floor(Math.random() * 3);
            this.shotCooldown += 0.7 + Math.random() * 0.8;
          }
        }
      }
    }

    // Объезд застреваний: если долго не сдвинулся — шаг в сторону
    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt;
      move = this.dodgeDir.clone();
      moveSpeed = Math.max(moveSpeed, 2.6);
    }
    move.y = 0;
    const len = move.length();
    const before = pos.clone();
    if (len > 0.05 && moveSpeed > 0) {
      move.scaleInPlace((moveSpeed * dt) / len);
      this.collider.moveWithCollisions(move);
      pos.y = 0;
    }
    this.speed = Vector3.Distance(before, pos) / Math.max(dt, 1e-4);

    this.stuckTimer += dt;
    if (this.stuckTimer > 0.8) {
      const movedSq = Vector3.DistanceSquared(this.stuckPos, pos);
      if (moveSpeed > 0 && movedSq < 0.25 && this.dodgeTimer <= 0) {
        // Застрял — отходим в случайную сторону и выбираем новую цель
        const a = Math.random() * Math.PI * 2;
        this.dodgeDir.set(Math.sin(a), 0, Math.cos(a));
        this.dodgeTimer = 0.9;
        if (this.state === "wander") this.goal = ctx.randomWalkPoint(pos, 25);
        this.strafeDir *= -1;
      }
      this.stuckTimer = 0;
      this.stuckPos.copyFrom(pos);
    }

    // Поворот к цели
    if (faceTarget) {
      const d = faceTarget.subtract(pos);
      if (d.x * d.x + d.z * d.z > 0.01) {
        const target = Math.atan2(d.x, d.z);
        const turn = angleDiff(this.yaw, target);
        const maxTurn = (this.state === "chase" ? 7 : 4) * dt;
        this.yaw += clamp(turn, -maxTurn, maxTurn);
      }
      if (this.state === "chase") {
        const hd = Math.hypot(d.x, d.z);
        this.aimPitch = -Math.atan2(faceTarget.y + 1.1 - 1.5, hd);
      } else {
        this.aimPitch = 0.1;
      }
    }

    this.allyMark?.setEnabled(true);
    this.allyMark?.position.set(pos.x, pos.y + 2.25, pos.z);

    // Полоска здоровья
    const showBar = ctx.now < this.hpBarShowUntil && this.hp < RULES.maxHp;
    this.hpBarBg.setEnabled(showBar);
    if (showBar) {
      this.hpBarBg.position.set(pos.x, pos.y + 2.15, pos.z);
      const k = this.hp / RULES.maxHp;
      this.hpBar.scaling.x = Math.max(0.001, k);
      this.hpBar.position.x = -(0.76 * (1 - k)) / 2;
    }

    this.syncHumanoid(dt);
  }

  private syncHumanoid(dt: number): void {
    const r = this.humanoid.root;
    r.position.copyFrom(this.collider.position);
    r.rotation.y = this.yaw;
    this.humanoid.animate(dt, this.speed, false, this.aimPitch, false);
  }
}
