import {
  Color3,
  DynamicTexture,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import { CLANS, type ClanId } from "@clan-battle/shared";
import { flatMat } from "./humanoid";
import { makeRng } from "./utils";

/** Тип объекта для выстрелов и видимости */
export type HitKind = "world" | "soft";

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface CoverSpot {
  x: number;
  z: number;
  r: number;
}

export interface BaseInfo {
  clan: ClanId;
  center: Vector3;
  /** Точки возрождения */
  spawns: Vector3[];
  /** Куда смотреть после возрождения */
  facing: number;
}

export const MAP_HALF = 64;

function tag(m: Mesh | InstancedMesh, kind: HitKind, collide: boolean): void {
  m.metadata = { kind };
  m.isPickable = true;
  m.checkCollisions = collide;
}

export class World {
  readonly obstacles: Rect[] = [];
  readonly covers: CoverSpot[] = [];
  readonly shadowCasters: (Mesh | InstancedMesh)[] = [];
  readonly bases: Record<ClanId, BaseInfo>;
  readonly ammoSpots: Vector3[] = [];
  private rng = makeRng(20260930);
  private staticMeshes: (Mesh | InstancedMesh)[] = [];

  // Общие материалы
  private mWood: StandardMaterial;
  private mWood2: StandardMaterial;
  private mWoodDark: StandardMaterial;
  private mRoof: StandardMaterial;
  private mRoof2: StandardMaterial;
  private mConcrete: StandardMaterial;

  constructor(private scene: Scene) {
    this.mWood = this.woodMat("wood", "#a8743f");
    this.mWood2 = this.woodMat("wood2", "#8d5b33");
    this.mWoodDark = flatMat(scene, "#5c3b22");
    this.mRoof = flatMat(scene, "#9c3b2b");
    this.mRoof2 = flatMat(scene, "#4f5d6b");
    this.mConcrete = flatMat(scene, "#8b8f94");

    this.buildGround();
    this.buildRoads();
    this.buildBorder();
    this.bases = {
      dragons: this.buildBase("dragons", -50, -50, 0),
      snakes: this.buildBase("snakes", 50, 50, Math.PI),
    };
    this.buildVillage();
    this.buildForest();
    this.buildHayField();
    this.scatterAmmo();

    for (const m of this.staticMeshes) {
      m.freezeWorldMatrix();
      m.doNotSyncBoundingInfo = true;
    }
  }

  // ---------- Материалы ----------

  private woodMat(name: string, hex: string): StandardMaterial {
    const tex = new DynamicTexture(`${name}_tex`, { width: 128, height: 128 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const base = Color3.FromHexString(hex);
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 128, 128);
    // Доски
    for (let i = 0; i < 8; i++) {
      const k = 0.85 + this.rng() * 0.25;
      ctx.fillStyle = base.scale(k).toHexString();
      ctx.fillRect(0, i * 16 + 1, 128, 14);
      ctx.fillStyle = "rgba(40,20,5,0.55)";
      ctx.fillRect(0, i * 16 + 15, 128, 2);
    }
    tex.update();
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    const m = new StandardMaterial(name, this.scene);
    m.diffuseTexture = tex;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    return m;
  }

  private register(m: Mesh | InstancedMesh, kind: HitKind | null, collide: boolean, shadow = false): void {
    if (kind) tag(m, kind, collide);
    else {
      m.isPickable = false;
      m.checkCollisions = collide;
    }
    if (shadow) this.shadowCasters.push(m);
    this.staticMeshes.push(m);
  }

  // ---------- Земля, дороги, граница ----------

  private buildGround(): void {
    const size = MAP_HALF * 2 + 60;
    const ground = MeshBuilder.CreateGround("ground", { width: size, height: size, subdivisions: 1 }, this.scene);
    const tex = new DynamicTexture("grass_tex", { width: 256, height: 256 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = "#5f9a3c";
    ctx.fillRect(0, 0, 256, 256);
    const shades = ["#56903a", "#6aa645", "#4f8636", "#74ad4c", "#5a9440"];
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = shades[i % shades.length];
      const x = this.rng() * 256;
      const y = this.rng() * 256;
      ctx.fillRect(x, y, 2 + this.rng() * 5, 2 + this.rng() * 5);
    }
    tex.update();
    tex.uScale = size / 8;
    tex.vScale = size / 8;
    const m = new StandardMaterial("grass", this.scene);
    m.diffuseTexture = tex;
    m.specularColor = Color3.Black();
    ground.material = m;
    ground.receiveShadows = true;
    this.register(ground, "world", false);
  }

  private buildRoads(): void {
    const mat = flatMat(this.scene, "#b39467");
    const roads: Rect[] = [
      { x0: -46, z0: 0, x1: 46, z1: 4 }, // главная улица деревни
      { x0: 1, z0: -34, x1: 5, z1: 34 }, // поперечная
      { x0: -50, z0: -46, x1: -46, z1: 0 }, // от базы Драконов
      { x0: 46, z0: 4, x1: 50, z1: 46 }, // к базе Змей
    ];
    roads.forEach((r, i) => {
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      const p = MeshBuilder.CreateGround(`road${i}`, { width: w, height: d }, this.scene);
      p.position.set((r.x0 + r.x1) / 2, 0.02 + i * 0.003, (r.z0 + r.z1) / 2);
      p.material = mat;
      p.receiveShadows = true;
      this.register(p, null, false);
      // Дороги отмечаем как занятые, чтобы на них не росли деревья
      this.obstacles.push({ x0: r.x0 - 1, z0: r.z0 - 1, x1: r.x1 + 1, z1: r.z1 + 1 });
    });
  }

  private buildBorder(): void {
    const H = MAP_HALF;
    // Невидимые стены
    const walls: [number, number, number, number][] = [
      [0, H + 0.5, H * 2 + 2, 1],
      [0, -H - 0.5, H * 2 + 2, 1],
      [H + 0.5, 0, 1, H * 2 + 2],
      [-H - 0.5, 0, 1, H * 2 + 2],
    ];
    walls.forEach(([x, z, w, d], i) => {
      const b = MeshBuilder.CreateBox(`border${i}`, { width: w, height: 6, depth: d }, this.scene);
      b.position.set(x, 3, z);
      b.isVisible = false;
      this.register(b, null, true);
    });
    // Деревянный забор по краю
    const rail = MeshBuilder.CreateBox("railBase", { width: 1, height: 0.12, depth: 0.08 }, this.scene);
    rail.material = this.mWoodDark;
    rail.isVisible = false;
    const post = MeshBuilder.CreateBox("postBase", { width: 0.15, height: 1.3, depth: 0.15 }, this.scene);
    post.material = this.mWoodDark;
    post.isVisible = false;
    const sides: [number, number, number][] = [
      [0, H, 0],
      [0, -H, 0],
      [H, 0, Math.PI / 2],
      [-H, 0, Math.PI / 2],
    ];
    sides.forEach(([x, z, rot], i) => {
      for (const y of [0.5, 1.0]) {
        const r = rail.createInstance(`rail${i}_${y}`);
        r.position.set(x, y, z);
        r.rotation.y = rot;
        r.scaling.x = H * 2;
        this.register(r, null, false);
      }
      for (let t = -H; t <= H; t += 4) {
        const p = post.createInstance(`post${i}_${t}`);
        p.position.set(rot ? x : t, 0.65, rot ? t : z);
        this.register(p, null, false);
      }
    });
  }

  // ---------- Базы кланов ----------

  private buildBase(clan: ClanId, cx: number, cz: number, rot: number): BaseInfo {
    const info = CLANS[clan];
    const root = new TransformNode(`base_${clan}`, this.scene);
    root.position.set(cx, 0, cz);
    root.rotation.y = rot;

    // Площадка
    const pad = MeshBuilder.CreateCylinder(`pad_${clan}`, { diameter: 18, height: 0.06, tessellation: 24 }, this.scene);
    pad.material = flatMat(this.scene, Color3.FromHexString(info.color).scale(0.55).toHexString());
    pad.position.set(cx, 0.03, cz);
    pad.receiveShadows = true;
    this.register(pad, null, false);

    // Бункер: бетонный домик с дверью, флаг на крыше
    const bunker = this.buildWalls(`bunker_${clan}`, 6, 5, 2.6, this.mConcrete, [
      [{ x: 0, w: 1.4, b: 0, t: 2.2 }],
      [{ x: -1.5, w: 0.8, b: 1.4, t: 1.9 }, { x: 1.5, w: 0.8, b: 1.4, t: 1.9 }],
      [{ x: 0, w: 0.8, b: 1.4, t: 1.9 }],
      [{ x: 0, w: 0.8, b: 1.4, t: 1.9 }],
    ]);
    // Дверь смотрит в центр карты: локальная -z → поворачиваем
    bunker.parent = root;
    bunker.rotation.y = Math.PI;
    bunker.position.z = -2;
    const roof = MeshBuilder.CreateBox(`bunkerRoof_${clan}`, { width: 6.6, height: 0.3, depth: 5.6 }, this.scene);
    roof.parent = root;
    roof.position.set(0, 2.75, -2);
    roof.material = flatMat(this.scene, "#6d7176");
    this.register(roof, "world", true, true);
    this.register(bunker, "world", true, true);
    const stripe = MeshBuilder.CreateBox(`bunkerStripe_${clan}`, { width: 6.05, height: 0.35, depth: 5.05 }, this.scene);
    stripe.parent = root;
    stripe.position.set(0, 2.2, -2);
    stripe.material = flatMat(this.scene, info.color);
    this.register(stripe, null, false);

    // Флагшток и флаг
    const pole = MeshBuilder.CreateCylinder(`pole_${clan}`, { diameter: 0.1, height: 5, tessellation: 6 }, this.scene);
    pole.parent = root;
    pole.position.set(0, 5.4, -2);
    pole.material = flatMat(this.scene, "#d9d9d9");
    this.register(pole, null, false, true);
    const flag = MeshBuilder.CreatePlane(`flag_${clan}`, { width: 2.2, height: 1.3, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    flag.parent = root;
    flag.position.set(1.15, 7.2, -2);
    flag.material = this.flagMaterial(clan);
    this.register(flag, null, false, true);

    // Мешки с песком — укрытие у входа
    const bagMat = flatMat(this.scene, "#b8a57a");
    for (const sx of [-3.2, 3.2]) {
      const bags = MeshBuilder.CreateBox(`bags_${clan}_${sx}`, { width: 2.4, height: 0.9, depth: 0.7 }, this.scene);
      bags.parent = root;
      bags.position.set(sx, 0.45, 3.2);
      bags.material = bagMat;
      this.register(bags, "world", true, true);
    }

    root.computeWorldMatrix(true);
    for (const c of root.getChildMeshes()) c.computeWorldMatrix(true);
    this.obstacles.push({ x0: cx - 10, z0: cz - 10, x1: cx + 10, z1: cz + 10 });

    const fwd = new Vector3(Math.sin(rot), 0, Math.cos(rot));
    const right = new Vector3(Math.cos(rot), 0, -Math.sin(rot));
    const center = new Vector3(cx, 0, cz);
    const spawns = [-3, -1, 1, 3].flatMap((s) => [
      center.add(fwd.scale(5.5)).add(right.scale(s * 1.2)),
      center.add(fwd.scale(7.5)).add(right.scale(s * 1.5)),
    ]);
    // Смотрим по диагонали в центр карты
    return { clan, center, spawns, facing: rot + Math.PI / 4 };
  }

  private flagMaterial(clan: ClanId): StandardMaterial {
    const info = CLANS[clan];
    const tex = new DynamicTexture(`flagTex_${clan}`, { width: 256, height: 160 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = info.color;
    ctx.fillRect(0, 0, 256, 160);
    ctx.fillStyle = info.accent;
    ctx.strokeStyle = info.accent;
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    if (clan === "snakes") {
      // Змея: S-образная линия с головой
      ctx.beginPath();
      ctx.moveTo(60, 125);
      ctx.bezierCurveTo(160, 125, 100, 80, 128, 70);
      ctx.bezierCurveTo(160, 58, 200, 60, 180, 35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(184, 32, 14, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Дракон: крылья и пламя
      ctx.beginPath();
      ctx.moveTo(128, 40);
      ctx.lineTo(60, 30);
      ctx.lineTo(90, 70);
      ctx.lineTo(50, 80);
      ctx.lineTo(128, 120);
      ctx.lineTo(206, 80);
      ctx.lineTo(166, 70);
      ctx.lineTo(196, 30);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff3c4";
      ctx.beginPath();
      ctx.arc(128, 75, 12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(info.name.toUpperCase(), 128, 152);
    tex.update();
    const m = new StandardMaterial(`flagMat_${clan}`, this.scene);
    m.diffuseTexture = tex;
    m.emissiveColor = new Color3(0.25, 0.25, 0.25);
    m.specularColor = Color3.Black();
    m.backFaceCulling = false;
    return m;
  }

  // ---------- Деревня ----------

  /**
   * Стены прямоугольного здания с проёмами. openings[i] — проёмы стены:
   * 0 — передняя (-z, дверь), 1 — задняя (+z), 2 — левая (-x), 3 — правая (+x).
   * x — центр проёма вдоль стены, w — ширина, b/t — низ и верх.
   */
  private buildWalls(
    name: string,
    w: number,
    d: number,
    h: number,
    mat: StandardMaterial,
    openings: { x: number; w: number; b: number; t: number }[][],
  ): Mesh {
    const T = 0.2;
    const pieces: Mesh[] = [];
    const wall = (len: number, ops: { x: number; w: number; b: number; t: number }[], px: number, pz: number, rotY: number) => {
      const segs: [number, number, number, number][] = []; // x0, x1, y0, y1
      let cur = -len / 2;
      for (const o of [...ops].sort((a, b) => a.x - b.x)) {
        const o0 = o.x - o.w / 2;
        const o1 = o.x + o.w / 2;
        if (o0 > cur) segs.push([cur, o0, 0, h]);
        if (o.b > 0) segs.push([o0, o1, 0, o.b]);
        if (o.t < h) segs.push([o0, o1, o.t, h]);
        cur = o1;
      }
      if (cur < len / 2) segs.push([cur, len / 2, 0, h]);
      for (const [x0, x1, y0, y1] of segs) {
        const b = MeshBuilder.CreateBox(`${name}_p`, { width: x1 - x0, height: y1 - y0, depth: T }, this.scene);
        const lx = (x0 + x1) / 2;
        const ly = (y0 + y1) / 2;
        // Локальный x стены поворачиваем на rotY
        b.position.set(px + Math.cos(rotY) * lx, ly, pz - Math.sin(rotY) * lx);
        b.rotation.y = rotY;
        pieces.push(b);
      }
    };
    wall(w, openings[0] ?? [], 0, -d / 2 + T / 2, 0);
    wall(w, openings[1] ?? [], 0, d / 2 - T / 2, Math.PI);
    wall(d - 2 * T, openings[2] ?? [], -w / 2 + T / 2, 0, -Math.PI / 2);
    wall(d - 2 * T, openings[3] ?? [], w / 2 - T / 2, 0, Math.PI / 2);
    const merged = Mesh.MergeMeshes(pieces, true, true)!;
    merged.name = name;
    merged.material = mat;
    merged.receiveShadows = true;
    return merged;
  }

  /** Треугольная призма-фронтон (локальные оси: ширина по x, глубина по z) */
  private gable(name: string, w: number, d: number, ph: number): Mesh {
    const hw = w / 2;
    const hd = d / 2;
    const positions = [
      // перед (z = -hd) и зад (z = +hd)? Призма вытянута по x, треугольник в плоскости yz
      -hw, 0, -hd, -hw, 0, hd, -hw, ph, 0,
      hw, 0, -hd, hw, 0, hd, hw, ph, 0,
    ];
    const indices = [0, 2, 1, 3, 4, 5];
    const m = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vd.normals = normals;
    vd.applyToMesh(m);
    return m;
  }

  private buildHouse(i: number, x: number, z: number, rotY: number): void {
    const w = 8;
    const d = 6;
    const h = 2.8;
    const wallMat = i % 2 === 0 ? this.mWood : this.mWood2;
    const roofMat = i % 3 === 0 ? this.mRoof2 : this.mRoof;
    const win = (cx: number) => ({ x: cx, w: 1.2, b: 1.0, t: 2.0 });
    const walls = this.buildWalls(`house${i}`, w, d, h, wallMat, [
      [{ x: 0, w: 1.3, b: 0, t: 2.25 }, win(-2.6), win(2.6)],
      [win(-2), win(2)],
      [win(0)],
      [win(0)],
    ]);
    const root = new TransformNode(`houseRoot${i}`, this.scene);
    root.position.set(x, 0, z);
    root.rotation.y = rotY;
    walls.parent = root;
    this.register(walls, "world", true, true);

    // Фронтоны (стены под крышей) и скаты крыши
    const ph = 1.5;
    const g = this.gable(`gable${i}`, w - 0.2, d, ph);
    g.parent = root;
    g.position.y = h;
    g.material = wallMat;
    g.material.backFaceCulling = false;
    this.register(g, "world", false, true);
    const slope = Math.atan2(ph, d / 2);
    const slabLen = Math.hypot(ph, d / 2) + 0.5;
    for (const s of [-1, 1]) {
      const slab = MeshBuilder.CreateBox(`roof${i}_${s}`, { width: w + 0.7, height: 0.12, depth: slabLen }, this.scene);
      slab.parent = root;
      slab.rotation.x = s * slope;
      const zc = (d / 2 + 0.5) / 2 - 0.12;
      const yTop = h + ph * (1 - zc / (d / 2));
      slab.position.set(0, yTop + 0.07 / Math.cos(slope), s * zc);
      slab.material = roofMat;
      this.register(slab, "world", false, true);
    }
    // Пол
    const floor = MeshBuilder.CreateGround(`floor${i}`, { width: w - 0.4, height: d - 0.4 }, this.scene);
    floor.parent = root;
    floor.position.y = 0.03;
    floor.material = this.mWoodDark;
    this.register(floor, null, false);
    // Стол внутри — укрытие у окна
    const table = MeshBuilder.CreateBox(`table${i}`, { width: 1.6, height: 0.8, depth: 0.9 }, this.scene);
    table.parent = root;
    table.position.set(-2, 0.4, 1.4);
    table.material = this.mWoodDark;
    this.register(table, "world", true, true);

    root.computeWorldMatrix(true);
    for (const c of root.getChildMeshes()) c.computeWorldMatrix(true);
    const ext = Math.abs(Math.sin(rotY)) > 0.5 ? [d / 2, w / 2] : [w / 2, d / 2];
    this.obstacles.push({ x0: x - ext[0] - 1.5, z0: z - ext[1] - 1.5, x1: x + ext[0] + 1.5, z1: z + ext[1] + 1.5 });
  }

  private buildCar(i: number, x: number, z: number, rotY: number, color: string): void {
    const body = MeshBuilder.CreateBox(`carBody${i}`, { width: 1.8, height: 0.7, depth: 4.2 }, this.scene);
    body.position.y = 0.65;
    const cabin = MeshBuilder.CreateBox(`carCabin${i}`, { width: 1.6, height: 0.62, depth: 2.2 }, this.scene);
    cabin.position.set(0, 1.3, -0.2);
    const glass = MeshBuilder.CreateBox(`carGlass${i}`, { width: 1.64, height: 0.4, depth: 2.0 }, this.scene);
    glass.position.set(0, 1.33, -0.2);
    const wheels: Mesh[] = [];
    for (const [wx, wz] of [
      [-0.85, 1.35],
      [0.85, 1.35],
      [-0.85, -1.35],
      [0.85, -1.35],
    ]) {
      const wh = MeshBuilder.CreateCylinder(`wheel${i}`, { diameter: 0.7, height: 0.3, tessellation: 10 }, this.scene);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(wx, 0.35, wz);
      wheels.push(wh);
    }
    body.material = flatMat(this.scene, color);
    cabin.material = body.material;
    glass.material = flatMat(this.scene, "#26323d");
    for (const wh of wheels) wh.material = flatMat(this.scene, "#1b1b1b");
    const car = Mesh.MergeMeshes([body, cabin, glass, ...wheels], true, true, undefined, false, true)!;
    car.name = `car${i}`;
    car.position.set(x, 0, z);
    car.rotation.y = rotY;
    car.computeWorldMatrix(true);
    car.receiveShadows = true;
    this.register(car, "world", true, true);
    this.covers.push({ x, z, r: 2.6 });
    this.obstacles.push({ x0: x - 2.6, z0: z - 2.6, x1: x + 2.6, z1: z + 2.6 });
  }

  private buildVillage(): void {
    const houses: [number, number, number][] = [
      [-16, -5, Math.PI],
      [-5, -6, Math.PI],
      [12, -5, Math.PI],
      [-14, 9, 0],
      [11, 9, 0],
      [24, 9, 0],
      [-27, -6, Math.PI],
      [-6, 22, Math.PI / 2],
      [14, -20, -Math.PI / 2],
    ];
    houses.forEach(([x, z, r], i) => this.buildHouse(i, x, z, r));

    const cars: [number, number, number, string][] = [
      [-22, -1.4, Math.PI / 2, "#2f6fd6"],
      [18, -1.4, -Math.PI / 2, "#e8e8e8"],
      [-6, 5.6, Math.PI / 2, "#d6b02f"],
      [7.5, -14, 0, "#b8322a"],
      [31, 5.6, Math.PI / 2, "#3f8f8a"],
      [-36, 5.6, -Math.PI / 2, "#7a4fb0"],
    ];
    cars.forEach(([x, z, r, c], i) => this.buildCar(i, x, z, r, c));

    // Немного сена и кустов у домов
    this.placeHayRound(-20, 15, 0.3);
    this.placeHayRound(18, 15, 1.2);
    this.placeHaySquare(-2, -16, 0.2);
    this.placeHaySquare(27, -3, 1.0);
    for (let i = 0; i < 26; i++) {
      const p = this.findFree(-38, -24, 38, 28, 1.2);
      if (p) this.placeBush(p.x, p.z);
    }
  }

  // ---------- Лес ----------

  private treeBases: { pineTrunk: Mesh; pineTop: Mesh; leafTrunk: Mesh; leafTop: Mesh } | null = null;

  private getTreeBases() {
    if (this.treeBases) return this.treeBases;
    const trunkMat = flatMat(this.scene, "#6b4a2b");
    const pineMat = flatMat(this.scene, "#2f6b3a");
    const leafMat = flatMat(this.scene, "#4f9a3a");

    const pineTrunk = MeshBuilder.CreateCylinder("pineTrunk", { diameterTop: 0.25, diameterBottom: 0.4, height: 2.4, tessellation: 6 }, this.scene);
    pineTrunk.position.y = 1.2;
    pineTrunk.bakeCurrentTransformIntoVertices();
    pineTrunk.material = trunkMat;
    const cones: Mesh[] = [];
    [
      [2.2, 3.2, 2.9],
      [1.7, 2.6, 4.4],
      [1.1, 2.0, 5.7],
    ].forEach(([dia, hgt, y], k) => {
      const c = MeshBuilder.CreateCylinder(`pineCone${k}`, { diameterTop: 0, diameterBottom: dia * 1.5, height: hgt, tessellation: 7 }, this.scene);
      c.position.y = y;
      cones.push(c);
    });
    const pineTop = Mesh.MergeMeshes(cones, true)!;
    pineTop.name = "pineTop";
    pineTop.material = pineMat;

    const leafTrunk = MeshBuilder.CreateCylinder("leafTrunk", { diameterTop: 0.25, diameterBottom: 0.38, height: 2.6, tessellation: 6 }, this.scene);
    leafTrunk.position.y = 1.3;
    leafTrunk.bakeCurrentTransformIntoVertices();
    leafTrunk.material = trunkMat;
    const blobs: Mesh[] = [];
    [
      [0, 3.6, 0, 3.0],
      [0.8, 3.1, 0.3, 2.0],
      [-0.7, 3.3, -0.4, 2.2],
    ].forEach(([bx, by, bz, s], k) => {
      const b = MeshBuilder.CreateIcoSphere(`leafBlob${k}`, { radius: s / 2, subdivisions: 1, flat: true }, this.scene);
      b.position.set(bx, by, bz);
      blobs.push(b);
    });
    const leafTop = Mesh.MergeMeshes(blobs, true)!;
    leafTop.name = "leafTop";
    leafTop.material = leafMat;

    for (const m of [pineTrunk, pineTop, leafTrunk, leafTop]) {
      m.isVisible = false;
      m.isPickable = false;
    }
    this.treeBases = { pineTrunk, pineTop, leafTrunk, leafTop };
    return this.treeBases;
  }

  private placeTree(x: number, z: number): void {
    const tb = this.getTreeBases();
    const pine = this.rng() < 0.55;
    const s = 0.8 + this.rng() * 0.5;
    const rot = this.rng() * Math.PI * 2;
    const trunk = (pine ? tb.pineTrunk : tb.leafTrunk).createInstance(`trunk_${x}_${z}`);
    trunk.position.set(x, 0, z);
    trunk.scaling.set(s, s, s);
    trunk.rotation.y = rot;
    const top = (pine ? tb.pineTop : tb.leafTop).createInstance(`top_${x}_${z}`);
    top.position.set(x, 0, z);
    top.scaling.set(s, s, s);
    top.rotation.y = rot;
    this.register(trunk, "world", true, true);
    this.register(top, "soft", false, true);
    this.obstacles.push({ x0: x - 1.2, z0: z - 1.2, x1: x + 1.2, z1: z + 1.2 });
  }

  private bushBase: Mesh | null = null;

  private placeBush(x: number, z: number): void {
    if (!this.bushBase) {
      const b = MeshBuilder.CreateIcoSphere("bushBase", { radius: 1, subdivisions: 1, flat: true }, this.scene);
      b.material = flatMat(this.scene, "#3e8a34");
      b.isVisible = false;
      b.isPickable = false;
      this.bushBase = b;
    }
    const s = 0.8 + this.rng() * 0.5;
    const inst = this.bushBase.createInstance(`bush_${x}_${z}`);
    inst.position.set(x, 0.45 * s, z);
    inst.scaling.set(1.2 * s, 0.85 * s, 1.2 * s);
    inst.rotation.y = this.rng() * 3;
    // Через куст можно пройти и спрятаться; он закрывает обзор, но не пули
    this.register(inst, "soft", false);
    this.covers.push({ x, z, r: 1.3 * s + 0.4 });
    this.obstacles.push({ x0: x - 1.2, z0: z - 1.2, x1: x + 1.2, z1: z + 1.2 });
  }

  private buildForest(): void {
    for (let i = 0; i < 75; i++) {
      const p = this.findFree(-62, 16, -10, 62, 1.6);
      if (p) this.placeTree(p.x, p.z);
    }
    for (let i = 0; i < 45; i++) {
      const p = this.findFree(-62, 16, -10, 62, 1.0);
      if (p) this.placeBush(p.x, p.z);
    }
    // Немного деревьев по всей карте
    for (let i = 0; i < 30; i++) {
      const p = this.findFree(-62, -62, 62, 62, 3);
      if (p) this.placeTree(p.x, p.z);
    }
    // Перелесок у баз
    for (let i = 0; i < 12; i++) {
      const p = this.findFree(20, 25, 62, 62, 2);
      if (p) this.placeBush(p.x, p.z);
      const q = this.findFree(-62, -62, -25, -20, 2);
      if (q) this.placeBush(q.x, q.z);
    }
  }

  // ---------- Поле с сеном ----------

  private hayMat(): StandardMaterial {
    return flatMat(this.scene, "#d9b44a");
  }

  private placeHayRound(x: number, z: number, rot: number): void {
    const c = MeshBuilder.CreateCylinder(`hayR_${x}_${z}`, { diameter: 1.6, height: 1.3, tessellation: 12 }, this.scene);
    c.rotation.set(0, rot, Math.PI / 2);
    c.position.set(x, 0.8, z);
    c.material = this.hayMat();
    c.receiveShadows = true;
    this.register(c, "world", true, true);
    this.covers.push({ x, z, r: 1.6 });
    this.obstacles.push({ x0: x - 1.5, z0: z - 1.5, x1: x + 1.5, z1: z + 1.5 });
  }

  private placeHaySquare(x: number, z: number, rot: number): void {
    const b = MeshBuilder.CreateBox(`hayS_${x}_${z}`, { width: 2.4, height: 0.9, depth: 1.1 }, this.scene);
    b.rotation.y = rot;
    b.position.set(x, 0.45, z);
    b.material = flatMat(this.scene, "#e3c35e");
    this.register(b, "world", true, true);
    if (this.rng() < 0.5) {
      const top = MeshBuilder.CreateBox(`hayS2_${x}_${z}`, { width: 1.2, height: 0.9, depth: 1.1 }, this.scene);
      top.rotation.y = rot;
      top.position.set(x, 1.35, z);
      top.material = b.material;
      this.register(top, "world", true, true);
    }
    this.covers.push({ x, z, r: 1.9 });
    this.obstacles.push({ x0: x - 1.8, z0: z - 1.8, x1: x + 1.8, z1: z + 1.8 });
  }

  private buildHayField(): void {
    // Поле посветлее
    const field = MeshBuilder.CreateGround("hayField", { width: 44, height: 40 }, this.scene);
    field.position.set(38, 0.012, -38);
    field.material = flatMat(this.scene, "#a7b04f");
    field.receiveShadows = true;
    this.register(field, null, false);
    for (let i = 0; i < 20; i++) {
      const p = this.findFree(18, -58, 60, -18, 1.5);
      if (p) this.placeHayRound(p.x, p.z, this.rng() * Math.PI);
    }
    for (let i = 0; i < 9; i++) {
      const p = this.findFree(18, -58, 60, -18, 1.5);
      if (p) this.placeHaySquare(p.x, p.z, this.rng() * Math.PI);
    }
    for (let i = 0; i < 8; i++) {
      const p = this.findFree(18, -58, 60, -18, 1);
      if (p) this.placeBush(p.x, p.z);
    }
  }

  private scatterAmmo(): void {
    const zones: [number, number, number, number][] = [
      [-40, -20, 40, 25], // деревня
      [-40, -20, 40, 25],
      [-40, -20, 40, 25],
      [-60, 18, -12, 60], // лес
      [-60, 18, -12, 60],
      [18, -58, 60, -18], // поле
      [18, -58, 60, -18],
      [-60, -60, 60, 60],
      [-60, -60, 60, 60],
      [-60, -60, 60, 60],
    ];
    for (const [x0, z0, x1, z1] of zones) {
      const p = this.findFree(x0, z0, x1, z1, 1);
      if (p) {
        this.ammoSpots.push(new Vector3(p.x, 0, p.z));
        this.obstacles.push({ x0: p.x - 1, z0: p.z - 1, x1: p.x + 1, z1: p.z + 1 });
      }
    }
  }

  // ---------- Свободные точки ----------

  isFree(x: number, z: number, margin = 0): boolean {
    if (Math.abs(x) > MAP_HALF - 2 || Math.abs(z) > MAP_HALF - 2) return false;
    for (const o of this.obstacles) {
      if (x > o.x0 - margin && x < o.x1 + margin && z > o.z0 - margin && z < o.z1 + margin) return false;
    }
    return true;
  }

  /** Случайная свободная точка в прямоугольнике (детерминированно для карты) */
  private findFree(x0: number, z0: number, x1: number, z1: number, margin: number): { x: number; z: number } | null {
    for (let k = 0; k < 40; k++) {
      const x = x0 + this.rng() * (x1 - x0);
      const z = z0 + this.rng() * (z1 - z0);
      if (this.isFree(x, z, margin)) return { x, z };
    }
    return null;
  }

  /** Точка для прогулки бота: свободная, но не обязательно вдали от дорог */
  randomWalkPoint(rnd: () => number, near?: Vector3, radius = 30): Vector3 {
    for (let k = 0; k < 30; k++) {
      const x = near ? near.x + (rnd() * 2 - 1) * radius : (rnd() * 2 - 1) * (MAP_HALF - 4);
      const z = near ? near.z + (rnd() * 2 - 1) * radius : (rnd() * 2 - 1) * (MAP_HALF - 4);
      if (Math.abs(x) > MAP_HALF - 3 || Math.abs(z) > MAP_HALF - 3) continue;
      if (this.isWalkable(x, z)) return new Vector3(x, 0, z);
    }
    return new Vector3(0, 0, 2);
  }

  /** Не внутри домов/машин/сена (дороги и базы можно) */
  private solidRects: Rect[] | null = null;
  isWalkable(x: number, z: number): boolean {
    if (!this.solidRects) {
      // Твёрдые препятствия — всё, кроме дорог и площадок баз (первые 4 — дороги)
      this.solidRects = this.obstacles.slice(4).filter((o) => o.x1 - o.x0 < 19);
    }
    for (const o of this.solidRects) {
      if (x > o.x0 + 0.5 && x < o.x1 - 0.5 && z > o.z0 + 0.5 && z < o.z1 - 0.5) return false;
    }
    return true;
  }

  /** Находится ли точка в укрытии (куст, сено, машина) */
  coverAt(x: number, z: number): boolean {
    for (const c of this.covers) {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) return true;
    }
    return false;
  }
}
