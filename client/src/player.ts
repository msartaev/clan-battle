import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { MOVEMENT, RULES, WEAPON_ORDER, type ClanId, type WeaponId } from "@clan-battle/shared";
import { Humanoid, randomLook } from "./humanoid";
import type { Input } from "./input";
import { MAP_HALF } from "./world";
import { clamp } from "./utils";

/** Игрок: движение с коллизиями, гравитация, присед, бег, прыжок */
export class Player {
  readonly collider: Mesh;
  readonly humanoid: Humanoid;
  yaw = 0;
  pitch = 0.05;
  vy = 0;
  grounded = true;
  crouching = false;
  sprinting = false;
  hp: number = RULES.maxHp;
  ammo: number = RULES.startAmmo;
  lives: number = RULES.lives;
  weapon: WeaponId = "weakPistol";
  alive = true;
  /** Время последнего выстрела (сек игрового времени) — для скрытности */
  lastShotAt = -999;
  lastDamageAt = -999;
  invulnerableUntil = 0;
  /** Горизонтальная скорость за последний кадр, м/с */
  speed = 0;
  private height: number = MOVEMENT.standHeight;
  private regenAcc = 0;

  constructor(scene: Scene, readonly clan: ClanId) {
    this.collider = MeshBuilder.CreateBox("playerCollider", { size: 0.5 }, scene);
    this.collider.isVisible = false;
    this.collider.isPickable = false;
    this.collider.checkCollisions = true;
    this.setColliderHeight(MOVEMENT.standHeight);
    this.humanoid = new Humanoid(scene, "player", randomLook(clan, () => 0.3));
  }

  get position(): Vector3 {
    return this.collider.position;
  }

  get eyeHeight(): number {
    return this.crouching ? MOVEMENT.eyeHeightCrouch : MOVEMENT.eyeHeightStand;
  }

  /** Верх «капсулы» для попаданий */
  get topHeight(): number {
    return this.crouching ? MOVEMENT.crouchHeight : MOVEMENT.standHeight;
  }

  private setColliderHeight(h: number): void {
    this.height = h;
    this.collider.ellipsoid = new Vector3(0.35, h / 2, 0.35);
    this.collider.ellipsoidOffset = new Vector3(0, h / 2, 0);
  }

  spawnAt(p: Vector3, yaw: number, now: number): void {
    this.collider.position.copyFrom(p);
    this.collider.position.y = 0.05;
    this.yaw = yaw;
    this.pitch = 0.05;
    this.vy = 0;
    this.hp = RULES.maxHp;
    this.ammo = RULES.startAmmo;
    this.alive = true;
    this.crouching = false;
    this.sprinting = false;
    this.setColliderHeight(MOVEMENT.standHeight);
    this.invulnerableUntil = now + 2;
    this.lastDamageAt = -999;
    this.humanoid.deathT = 0;
    this.humanoid.setEnabled(true);
    this.syncHumanoid(0);
  }

  update(dt: number, input: Input, now: number, canStand: () => boolean): void {
    if (!this.alive) return;

    // Поворот
    this.yaw += input.lookDX;
    this.pitch = clamp(this.pitch + input.lookDY, -1.35, 1.35);

    // Присед: встать можно, только если над головой свободно
    const wantCrouch = input.crouch;
    if (wantCrouch && !this.crouching) {
      this.crouching = true;
      this.setColliderHeight(MOVEMENT.crouchHeight);
    } else if (!wantCrouch && this.crouching && canStand()) {
      this.crouching = false;
      this.setColliderHeight(MOVEMENT.standHeight);
    }

    const moving = Math.abs(input.moveX) + Math.abs(input.moveZ) > 0.05;
    this.sprinting = input.sprint && !this.crouching && moving && input.moveZ > 0.1;
    const speed = this.crouching ? MOVEMENT.crouchSpeed : this.sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const fx = sin * input.moveZ + cos * input.moveX;
    const fz = cos * input.moveZ - sin * input.moveX;
    const before = this.collider.position.clone();

    // Горизонтальное движение со скольжением вдоль стен
    if (moving) {
      this.collider.moveWithCollisions(new Vector3(fx * speed * dt, 0, fz * speed * dt));
    }

    // Прыжок и гравитация
    if (input.jumpPressed && this.grounded && !this.crouching) {
      this.vy = MOVEMENT.jumpSpeed;
      this.grounded = false;
    }
    this.vy -= MOVEMENT.gravity * dt;
    const dy = this.vy * dt;
    const y0 = this.collider.position.y;
    this.collider.moveWithCollisions(new Vector3(0, dy, 0));
    const moved = this.collider.position.y - y0;
    if (dy < 0 && moved > dy * 0.5) {
      // Упёрлись во что-то снизу — стоим
      this.grounded = true;
      this.vy = 0;
    } else if (dy > 0 && moved < dy * 0.5) {
      // Ударились головой
      this.vy = 0;
      this.grounded = false;
    } else {
      this.grounded = false;
    }
    // Земля
    if (this.collider.position.y <= 0) {
      this.collider.position.y = 0;
      this.vy = 0;
      this.grounded = true;
    }
    // Не выходим за карту (на всякий случай)
    const lim = MAP_HALF - 0.5;
    this.collider.position.x = clamp(this.collider.position.x, -lim, lim);
    this.collider.position.z = clamp(this.collider.position.z, -lim, lim);

    const after = this.collider.position;
    this.speed = Math.hypot(after.x - before.x, after.z - before.z) / Math.max(dt, 1e-4);

    // Восстановление здоровья: 1 в секунду после 5 секунд без урона
    if (this.hp < RULES.maxHp && now - this.lastDamageAt > RULES.regenDelaySec) {
      this.regenAcc += RULES.regenPerSec * dt;
      if (this.regenAcc >= 1) {
        const k = Math.floor(this.regenAcc);
        this.hp = Math.min(RULES.maxHp, this.hp + k);
        this.regenAcc -= k;
      }
    } else {
      this.regenAcc = 0;
    }

    this.syncHumanoid(dt);
  }

  syncHumanoid(dt: number): void {
    const r = this.humanoid.root;
    r.position.copyFrom(this.collider.position);
    r.rotation.y = this.yaw;
    this.humanoid.animate(dt, this.speed, this.crouching, this.pitch, !this.grounded);
  }

  /** Возвращает true, если игрок погиб от этого урона */
  takeDamage(amount: number, now: number): boolean {
    if (!this.alive || now < this.invulnerableUntil) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.lastDamageAt = now;
    if (this.hp <= 0) {
      this.alive = false;
      this.lives -= 1;
      return true;
    }
    return false;
  }

  selectWeapon(idx: number): void {
    const id = WEAPON_ORDER[idx];
    if (id) {
      this.weapon = id;
      this.humanoid.setWeapon(id);
    }
  }

  cycleWeapon(dir: number): void {
    const i = WEAPON_ORDER.indexOf(this.weapon);
    const n = WEAPON_ORDER.length;
    this.selectWeapon((i + dir + n) % n);
  }

  get colliderHeight(): number {
    return this.height;
  }
}
