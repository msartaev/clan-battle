import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";

/**
 * Дроны леса (идея Даниэля): висят над деревьями, следят за боем и время от времени
 * стреляют лазером в кого-нибудь внизу — в любого, без разбора кланов. Их можно сбить.
 */

export interface DroneTarget {
  pos: Vector3;
  readonly alive: boolean;
  hurt(dmg: number, from: Vector3): void;
}

let counter = 0;

export class Drone {
  readonly id = ++counter;
  readonly root: TransformNode;
  hp = 40;
  private rotors: Mesh[] = [];
  private goal = new Vector3();
  private fireIn = 4 + Math.random() * 4;
  private deadTimer = 0;
  private fallV = 0;
  /** Последний выстрел — чтобы игра нарисовала луч */
  lastShot: { from: Vector3; to: Vector3 } | null = null;

  constructor(
    scene: Scene,
    private area: { x0: number; z0: number; x1: number; z1: number },
    private ground: (x: number, z: number) => number,
  ) {
    this.root = new TransformNode(`drone${this.id}`, scene);
    const dark = new StandardMaterial(`droneMat${this.id}`, scene);
    dark.diffuseColor = new Color3(0.16, 0.17, 0.19);
    dark.specularColor = new Color3(0.4, 0.4, 0.4);
    const led = new StandardMaterial(`droneLed${this.id}`, scene);
    led.emissiveColor = new Color3(1, 0.15, 0.1);
    led.disableLighting = true;
    const body = MeshBuilder.CreateBox("droneBody", { width: 0.5, height: 0.16, depth: 0.5 }, scene);
    body.material = dark;
    body.parent = this.root;
    const eye = MeshBuilder.CreateSphere("droneEye", { diameter: 0.14, segments: 8 }, scene);
    eye.material = led;
    eye.parent = this.root;
    eye.position.set(0, -0.1, 0.2);
    for (const [x, z] of [[0.38, 0.38], [-0.38, 0.38], [0.38, -0.38], [-0.38, -0.38]]) {
      const arm = MeshBuilder.CreateBox("droneArm", { width: 0.06, height: 0.04, depth: 0.55 }, scene);
      arm.material = dark;
      arm.parent = this.root;
      arm.position.set(x / 2, 0, z / 2);
      arm.rotation.y = Math.atan2(x, z);
      const rotor = MeshBuilder.CreateDisc("droneRotor", { radius: 0.2, tessellation: 3 }, scene);
      rotor.rotation.x = Math.PI / 2;
      rotor.material = dark;
      rotor.parent = this.root;
      rotor.position.set(x, 0.08, z);
      this.rotors.push(rotor);
    }
    for (const m of this.root.getChildMeshes()) m.isPickable = false;
    this.respawn();
  }

  get pos(): Vector3 {
    return this.root.position;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  private randomPoint(): Vector3 {
    const a = this.area;
    const x = a.x0 + Math.random() * (a.x1 - a.x0);
    const z = a.z0 + Math.random() * (a.z1 - a.z0);
    return new Vector3(x, this.ground(x, z) + 9 + Math.random() * 4, z);
  }

  respawn(): void {
    this.hp = 40;
    this.root.position.copyFrom(this.randomPoint());
    this.goal = this.randomPoint();
    this.root.rotation.set(0, 0, 0);
    this.root.setEnabled(true);
    this.deadTimer = 0;
    this.fallV = 0;
  }

  /** Попадание; true — сбит */
  takeDamage(dmg: number): boolean {
    if (!this.alive) return false;
    this.hp -= dmg;
    return this.hp <= 0;
  }

  /** Луч к цели — для проверки прямой видимости даёт игра */
  update(dt: number, targets: DroneTarget[], canSee: (from: Vector3, to: Vector3) => boolean): void {
    this.lastShot = null;
    if (!this.alive) {
      // Падает, кувыркаясь, и через минуту прилетает новый
      this.deadTimer += dt;
      const p = this.root.position;
      const g = this.ground(p.x, p.z);
      if (p.y > g + 0.2) {
        this.fallV += 12 * dt;
        p.y = Math.max(g + 0.2, p.y - this.fallV * dt);
        this.root.rotation.x += dt * 5;
      }
      if (this.deadTimer > 8) this.root.setEnabled(false);
      if (this.deadTimer > 60) this.respawn();
      return;
    }
    for (const r of this.rotors) r.rotation.y += dt * 40;
    const p = this.root.position;
    const to = this.goal.subtract(p);
    const d = to.length();
    if (d < 1) this.goal = this.randomPoint();
    else p.addInPlace(to.scale(Math.min(1, (3 * dt) / d)));
    // Лёгкое покачивание в воздухе
    p.y += Math.sin(performance.now() / 300 + this.id) * 0.01;
    this.root.rotation.z = Math.sin(performance.now() / 500 + this.id) * 0.08;

    this.fireIn -= dt;
    if (this.fireIn > 0) return;
    this.fireIn = 5 + Math.random() * 5;
    // Иногда стреляет в случайного видимого бойца внизу
    const vis = targets.filter((t) => t.alive && Vector3.Distance(t.pos, p) < 32 && canSee(p, t.pos.add(new Vector3(0, 1.2, 0))));
    if (!vis.length) return;
    const t = vis[Math.floor(Math.random() * vis.length)];
    const aim = t.pos.add(new Vector3(0, 1.1, 0));
    this.lastShot = { from: p.clone(), to: aim };
    // Мажет примерно в трети случаев
    if (Math.random() < 0.66) t.hurt(8, p.clone());
  }
}
