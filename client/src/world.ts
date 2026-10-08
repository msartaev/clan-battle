import {
  AbstractMesh,
  Color3,
  DynamicTexture,
  InstancedMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { CLANS, type ClanId } from "@clan-battle/shared";
import { flatMat } from "./humanoid";
import { getModels, type NatureId } from "./models";
import { buildTreeBases, grassTuftMesh, type TreeBases } from "./trees";
import { buildCarMesh, type CarKind } from "./cars";
import { makeRng } from "./utils";

/** Тип объекта для выстрелов и видимости */
export type HitKind = "world" | "soft" | "glass";

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
  /** Точка захвата флага — центр бункера на земле */
  flagPoint: Vector3;
  /** Полотнище флага: опускается по флагштоку, пока флаг захватывают */
  flag: Mesh;
}

/** Половина стороны карты, м (уровень 1 — 64, уровень 2 — 100) */
/** Сколько ударов мечом выдерживает дерево */
export const TREE_HP = 5;

export let MAP_HALF = 64;

/**
 * Подвал под домом №3 на главной улице (дом в (-14, 9)): люк в полу и комната под землёй.
 * Вниз — по ступенькам, вверх — прыжками со ступеньки на ступеньку, как в Майнкрафте.
 */
export const CELLAR = {
  room: { x0: -17.4, x1: -10.6, z0: 6.6, z1: 11.4 },
  // Проём над всей лестницей, иначе со ступенек «выталкивает» на пол дома
  hole: { x0: -14.6, x1: -11.2, z0: 9.6, z1: 10.8 },
  floor: -2.6,
  house: 3,
};

/** Где стоит деревня на уровне 2 (сдвиг всей деревни уровня 1) */
export const VILLAGE2 = { x: -48, z: 48 };
/** Гора на уровне 2: юго-восточный угол, на неё можно подняться */
export const MOUNTAIN = { x: 58, z: -58, r: 40, h: 16 };

const inRect = (r: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number, m = 0) =>
  x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m;

/** Стекло в окне: целое не пускает и останавливает пули, разбитое — можно залезть */
export interface TreeInfo {
  pos: Vector3;
  mesh: InstancedMesh;
  trunk: InstancedMesh;
  rect: Rect;
  rot: number;
  pine: boolean;
  /** Сколько ударов мечом ещё выдержит */
  hp: number;
  /** 0 — стоит; >0 — сколько секунд как падает/лежит */
  fallT: number;
  fallDir: number;
}

/** Гоночная трасса уровня 5: осевая линия, ширина, контрольные точки кругов */
export interface Track {
  pts: Vector3[];
  /** Направление движения в каждой точке */
  tan: Vector3[];
  width: number;
  /** Индекс точки на линии старта */
  startIdx: number;
  /** Контрольные точки (индексы в pts) — по порядку, первая — старт */
  cps: number[];
  /** Где стоят машины перед стартом (в пещере) */
  grid: { pos: Vector3; yaw: number }[];
}

export interface WindowPane {
  mesh: Mesh;
  /** Центр окна и наружная нормаль стены (в мире) */
  center: Vector3;
  normal: Vector3;
  /** Низ проёма над землёй, м */
  sill: number;
  broken: boolean;
}

interface WindowSpec {
  pos: Vector3;
  rotY: number;
  w: number;
  h: number;
  sill: number;
}

function tag(m: Mesh | InstancedMesh, kind: HitKind, collide: boolean): void {
  m.metadata = { kind };
  m.isPickable = true;
  m.checkCollisions = collide;
}

/**
 * UV по мировой проекции (как «кубическая» развёртка): текстура ложится с одинаковым масштабом
 * на любые куски стен, полов и крыш, без растяжения по граням.
 * @param tile сколько метров на один повтор текстуры
 */
function projectUV(mesh: Mesh, tile: number): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nrm) return;
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const ax = Math.abs(nrm[i]);
    const ay = Math.abs(nrm[i + 1]);
    const az = Math.abs(nrm[i + 2]);
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = pos[i];
      v = pos[i + 2];
    } else if (ax >= az) {
      u = pos[i + 2];
      v = pos[i + 1];
    } else {
      u = pos[i];
      v = pos[i + 1];
    }
    uv[j] = u / tile;
    uv[j + 1] = v / tile;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uv, false);
}

const photoMats = new Map<string, StandardMaterial>();

/** Материал с фото-текстурой Poly Haven (CC0, 512 px), общий на всю сцену */
function photoMat(scene: Scene, file: string, tint = "#ffffff"): StandardMaterial {
  const key = `${file}|${tint}`;
  let m = photoMats.get(key);
  if (!m || m.getScene() !== scene) {
    m = new StandardMaterial(`photo_${key}`, scene);
    const t = new Texture(`./textures/${file}.jpg`, scene);
    t.anisotropicFilteringLevel = 4;
    m.diffuseTexture = t;
    m.diffuseColor = Color3.FromHexString(tint);
    m.specularColor.set(0.04, 0.04, 0.04);
    photoMats.set(key, m);
  }
  return m;
}

export class World {
  readonly windows: WindowPane[] = [];
  /** Сугробы уровня 4: в них проваливаешься и замерзаешь */
  readonly drifts: { x: number; z: number; r: number }[] = [];
  /** Точки появления в режиме «каждый сам за себя» */
  readonly ffaSpawns: Vector3[] = [];
  /** Где не сыпать траву и пни (бетон, полы) */
  private noDecor: Rect[] = [];
  /** Стволы деревьев — по ним рубят дерево для торговца */
  readonly treeSpots: Vector3[] = [];
  /** Деревья, которые можно срубить: крона, невидимый ствол, препятствие для ботов */
  readonly treeList: TreeInfo[] = [];
  track: Track | null = null;
  /** Зрители на трибунах (уровень 5) — машут руками */
  fans: Mesh | null = null;
  /** Машины деревни: на них можно ездить */
  readonly cars: { mesh: Mesh; yaw: number; home: Vector3; homeYaw: number }[] = [];
  private glassMat: StandardMaterial | null = null;
  readonly obstacles: Rect[] = [];
  readonly covers: CoverSpot[] = [];
  readonly shadowCasters: (Mesh | InstancedMesh)[] = [];
  bases!: Record<ClanId, BaseInfo>;
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

  /** Уровень: 1 — деревня, 2 — большая карта с биомами */
  readonly level: number;

  constructor(private scene: Scene, private detail = 1, level = 1) {
    this.level = level;
    MAP_HALF = level === 2 || level === 5 ? 100 : level === 3 ? 45 : level === 4 ? 50 : 64;
    // Подвал переезжает вместе с деревней (на уровне 2 она в северо-западном углу)
    const vo = level === 2 ? VILLAGE2 : { x: 0, z: 0 };
    CELLAR.room = { x0: -17.4 + vo.x, x1: -10.6 + vo.x, z0: 6.6 + vo.z, z1: 11.4 + vo.z };
    CELLAR.hole = { x0: -14.6 + vo.x, x1: -11.2 + vo.x, z0: 9.6 + vo.z, z1: 10.8 + vo.z };
    if (level >= 3) {
      // Деревни нет — «люк» уводим за забор, крошечный и незаметный
      CELLAR.room = { x0: 70, x1: 70.2, z0: 70, z1: 70.2 };
      CELLAR.hole = { x0: 70, x1: 70.2, z0: 70, z1: 70.2 };
    }
    // Старые процедурные доски брали 16 чисел из генератора карты — сохраняем раскладку
    for (let i = 0; i < 16; i++) this.rng();
    this.mWood = photoMat(scene, "weathered_planks");
    this.mWood2 = photoMat(scene, "brown_planks_05");
    this.mWoodDark = flatMat(scene, "#5c3b22");
    this.mRoof = photoMat(scene, "clay_roof_tiles_02");
    this.mRoof2 = photoMat(scene, "grey_roof_tiles");
    this.mConcrete = flatMat(scene, "#8b8f94");

    this.buildGround();
    if (level === 2) {
      this.buildLevel2();
    } else if (level === 3) {
      this.buildLevel3();
    } else if (level === 4) {
      this.buildLevel4();
    } else if (level === 5) {
      this.buildLevel5();
    } else {
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
      this.buildStones();
    }
    this.extraTrees();
    this.scatterDecor(this.detail);

    for (const m of this.staticMeshes) {
      m.freezeWorldMatrix();
      m.doNotSyncBoundingInfo = true;
    }
  }

  // ---------- Материалы ----------

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
    // Земля из четырёх кусков вокруг люка подвала — иначе сквозь неё не спуститься и не увидеть подвал
    const H = size / 2;
    const h = CELLAR.hole;
    const pieces: [number, number, number, number][] = [
      [-H, H, -H, h.z0],
      [-H, H, h.z1, H],
      [-H, h.x0, h.z0, h.z1],
      [h.x1, H, h.z0, h.z1],
    ];
    const parts = pieces.map(([x0, x1, z0, z1], k) => {
      const g = MeshBuilder.CreateGround(`ground${k}`, { width: x1 - x0, height: z1 - z0 }, this.scene);
      g.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      g.bakeCurrentTransformIntoVertices();
      return g;
    });
    const ground = Mesh.MergeMeshes(parts, true, true)!;
    ground.name = "ground";
    // Раньше тут рисовалась процедурная текстура травы на этом же генераторе;
    // прокручиваем его столько же раз, чтобы раскладка карты не съехала
    for (let i = 0; i < 1400 * 4; i++) this.rng();
    projectUV(ground, 6);
    ground.material = this.level === 4 ? photoMat(this.scene, "snow_02", "#f4f8ff") : photoMat(this.scene, "leafy_grass", "#d8e8c8");
    ground.receiveShadows = true;
    this.register(ground, "world", false);
  }

  private buildRoads(
    roads: Rect[] = [
      { x0: -46, z0: 0, x1: 46, z1: 4 }, // главная улица деревни
      { x0: 1, z0: -34, x1: 5, z1: 34 }, // поперечная
      { x0: -50, z0: -46, x1: -46, z1: 0 }, // от базы Драконов
      { x0: 46, z0: 4, x1: 50, z1: 46 }, // к базе Змей
    ],
  ): void {
    const mat = photoMat(this.scene, "dirt_floor");
    roads.forEach((r, i) => {
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      const p = MeshBuilder.CreateGround(`road${i}`, { width: w, height: d }, this.scene);
      p.position.set((r.x0 + r.x1) / 2, 0.02 + i * 0.003, (r.z0 + r.z1) / 2);
      projectUV(p, 4);
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

  private buildBase(clan: ClanId, cx: number, cz: number, rot: number, facing?: number): BaseInfo {
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
    const bunkerWindows: WindowSpec[] = [];
    const bunker = this.buildWalls(
      `bunker_${clan}`,
      6,
      5,
      2.6,
      this.mConcrete,
      [
        [{ x: 0, w: 1.4, b: 0, t: 2.2 }],
        [{ x: -1.5, w: 0.8, b: 1.4, t: 1.9 }, { x: 1.5, w: 0.8, b: 1.4, t: 1.9 }],
        [{ x: 0, w: 0.8, b: 1.4, t: 1.9 }],
        [{ x: 0, w: 0.8, b: 1.4, t: 1.9 }],
      ],
      bunkerWindows,
    );
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
    // Бункер повёрнут на 180° и сдвинут — стёкла ставим в той же системе координат
    this.glaze(`bunker_${clan}`, root, bunkerWindows, Math.PI, new Vector3(0, 0, -2));
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
    const flagPoint = Vector3.TransformCoordinates(new Vector3(0, 0, -2), root.getWorldMatrix());
    // Смотрим по диагонали в центр карты
    return { clan, center, spawns, facing: facing ?? rot + Math.PI / 4, flagPoint, flag };
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
    windows?: WindowSpec[],
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
        if (o.b > 0) {
          segs.push([o0, o1, 0, o.b]);
          // Окно (проём не от пола) — запоминаем место для стекла
          windows?.push({
            pos: new Vector3(px + Math.cos(rotY) * o.x, (o.b + Math.min(o.t, h)) / 2, pz - Math.sin(rotY) * o.x),
            rotY,
            w: o.w,
            h: Math.min(o.t, h) - o.b,
            sill: o.b,
          });
        }
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
    projectUV(merged, 2);
    merged.name = name;
    merged.material = mat;
    merged.receiveShadows = true;
    return merged;
  }

  /** Пол дома с люком, сам подвал и ступеньки. Дом подвала не повёрнут (rotY = 0) */
  private buildCellar(_root: TransformNode, hx: number, hz: number, w: number, d: number): void {
    const h = CELLAR.hole;
    const r = CELLAR.room;
    const F = CELLAR.floor;
    const wood = this.mWoodDark;
    const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: StandardMaterial, kind: HitKind | null, collide: boolean) => {
      const b = MeshBuilder.CreateBox(name, { width: x1 - x0, height: y1 - y0, depth: z1 - z0 }, this.scene);
      b.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      b.material = mat;
      projectUV(b, 2);
      b.receiveShadows = true;
      this.register(b, kind, collide);
      return b;
    };
    // Пол дома: четыре доски вокруг люка (в мировых координатах)
    const fx0 = hx - w / 2 + 0.2;
    const fx1 = hx + w / 2 - 0.2;
    const fz0 = hz - d / 2 + 0.2;
    const fz1 = hz + d / 2 - 0.2;
    box("cellarFloorA", fx0, fx1, 0.0, 0.04, fz0, h.z0, wood, null, false);
    box("cellarFloorB", fx0, fx1, 0.0, 0.04, h.z1, fz1, wood, null, false);
    box("cellarFloorC", fx0, h.x0, 0.0, 0.04, h.z0, h.z1, wood, null, false);
    box("cellarFloorD", h.x1, fx1, 0.0, 0.04, h.z0, h.z1, wood, null, false);
    // Откинутая крышка люка у края
    const lid = MeshBuilder.CreateBox("cellarLid", { width: 1.2, height: 0.06, depth: 1.2 }, this.scene);
    lid.position.set(h.x0 - 0.05, 0.6, (h.z0 + h.z1) / 2);
    lid.rotation.z = Math.PI / 2 - 0.25;
    lid.material = this.mWood2;
    this.register(lid, null, false);

    // Комната: бетон и доски
    const wall = this.mConcrete;
    box("cellarFloor", r.x0, r.x1, F - 0.1, F, r.z0, r.z1, wood, "world", true);
    // Потолок под землёй — со дна виден, с вырезом под люк
    box("cellarCeilA", r.x0, r.x1, -0.12, -0.02, r.z0, h.z0, wall, "world", true);
    box("cellarCeilB", r.x0, r.x1, -0.12, -0.02, h.z1, r.z1, wall, "world", true);
    box("cellarCeilC", r.x0, h.x0, -0.12, -0.02, h.z0, h.z1, wall, "world", true);
    box("cellarCeilD", h.x1, r.x1, -0.12, -0.02, h.z0, h.z1, wall, "world", true);
    box("cellarWallN", r.x0 - 0.2, r.x1 + 0.2, F, 0, r.z1, r.z1 + 0.2, wall, "world", true);
    box("cellarWallS", r.x0 - 0.2, r.x1 + 0.2, F, 0, r.z0 - 0.2, r.z0, wall, "world", true);
    box("cellarWallW", r.x0 - 0.2, r.x0, F, 0, r.z0, r.z1, wall, "world", true);
    box("cellarWallE", r.x1, r.x1 + 0.2, F, 0, r.z0, r.z1, wall, "world", true);
    // Стенки шахты люка между полом дома и потолком подвала не нужны: потолок и есть земля
    // Ступеньки: самая верхняя прямо под люком, ниже — к западу; высота 0.43 м — только прыжком
    const steps = 6;
    const rise = (0 - F) / steps;
    const zc0 = h.z0 + 0.1;
    const zc1 = h.z1 - 0.1;
    for (let k = 1; k <= steps; k++) {
      const top = F + rise * k - 0.02;
      // Верхняя ступенька упирается в восточный край люка — с неё сразу шаг на пол дома
      const xc = h.x1 - 0.24 - (steps - k) * 0.48;
      box(`cellarStep${k}`, xc - 0.24, xc + 0.24, F, top, zc0, zc1, wood, "world", true);
    }
    // Ящики и бочка — укрытия внутри
    box("cellarCrateA", r.x0 + 0.3, r.x0 + 1.3, F, F + 0.9, r.z0 + 0.3, r.z0 + 1.3, this.mWood2, "world", true);
    box("cellarCrateB", r.x0 + 0.3, r.x0 + 1.0, F, F + 0.7, r.z0 + 1.5, r.z0 + 2.2, this.mWood, "world", true);
  }

  /** Высота рельефа: на уровне 2 — гора в юго-восточном углу, иначе ровно */
  heightAt(x: number, z: number): number {
    if (this.level !== 2) return 0;
    const dx = x - MOUNTAIN.x;
    const dz = z - MOUNTAIN.z;
    const d = Math.hypot(dx, dz);
    if (d >= MOUNTAIN.r) return 0;
    const t = 1 - d / MOUNTAIN.r;
    const smooth = t * t * (3 - 2 * t);
    // Хребты по кругу — склоны неровные, есть где спрятаться
    const ridge = Math.sin(Math.atan2(dz, dx) * 5) * 1.6 * t * (1 - t) * 4;
    // Плоская площадка на вершине — смотровая точка
    return Math.min(MOUNTAIN.h * 0.92, MOUNTAIN.h * Math.pow(smooth, 1.15) + ridge);
  }

  /** Высота пола под точкой: в подвале — его пол, иначе земля или склон горы */
  floorAt(x: number, z: number, y: number): number {
    // Под землёй или прямо над люком — пол подвала
    if (inRect(CELLAR.room, x, z) && (y < -0.15 || inRect(CELLAR.hole, x, z))) return CELLAR.floor;
    return this.heightAt(x, z);
  }

  /** Стёкла во все окна дома или бункера (root — его корень) */
  private glaze(prefix: string, root: TransformNode, specs: WindowSpec[], extraRotY = 0, offset = Vector3.Zero()): void {
    if (!this.glassMat) {
      const m = new StandardMaterial("glass", this.scene);
      m.diffuseColor = new Color3(0.55, 0.7, 0.8);
      m.specularColor = new Color3(0.9, 0.9, 0.9);
      m.specularPower = 96;
      m.alpha = 0.32;
      m.backFaceCulling = false;
      this.glassMat = m;
    }
    root.computeWorldMatrix(true);
    specs.forEach((sp, i) => {
      const pane = MeshBuilder.CreateBox(`${prefix}_glass${i}`, { width: sp.w, height: sp.h, depth: 0.04 }, this.scene);
      const holder = new TransformNode(`${prefix}_gh${i}`, this.scene);
      holder.parent = root;
      holder.rotation.y = extraRotY;
      holder.position.copyFrom(offset);
      pane.parent = holder;
      pane.position.copyFrom(sp.pos);
      pane.rotation.y = sp.rotY;
      pane.material = this.glassMat!;
      tag(pane, "glass", true);
      pane.computeWorldMatrix(true);
      const center = pane.getAbsolutePosition().clone();
      const normal = pane.getDirection(new Vector3(0, 0, 1)).normalize();
      normal.y = 0;
      this.windows.push({ mesh: pane, center, normal: normal.normalize(), sill: sp.sill, broken: false });
    });
  }

  /** Разбить окно: стекло пропадает, проём свободен */
  breakWindow(pane: WindowPane): void {
    if (pane.broken) return;
    pane.broken = true;
    pane.mesh.setEnabled(false);
    pane.mesh.checkCollisions = false;
  }

  /** Новый матч — все окна снова целые */
  repairWindows(): void {
    for (const w of this.windows) {
      w.broken = false;
      w.mesh.setEnabled(true);
      w.mesh.checkCollisions = true;
    }
  }

  windowOf(mesh: AbstractMesh): WindowPane | undefined {
    return this.windows.find((w) => w.mesh === mesh);
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
    projectUV(m, 2);
    return m;
  }

  private buildHouse(i: number, x: number, z: number, rotY: number): void {
    const w = 8;
    const d = 6;
    const h = 2.8;
    const wallMat = i % 2 === 0 ? this.mWood : this.mWood2;
    const roofMat = i % 3 === 0 ? this.mRoof2 : this.mRoof;
    const win = (cx: number) => ({ x: cx, w: 1.2, b: 1.0, t: 2.0 });
    const specs: WindowSpec[] = [];
    const walls = this.buildWalls(
      `house${i}`,
      w,
      d,
      h,
      wallMat,
      [[{ x: 0, w: 1.3, b: 0, t: 2.25 }, win(-2.6), win(2.6)], [win(-2), win(2)], [win(0)], [win(0)]],
      specs,
    );
    const root = new TransformNode(`houseRoot${i}`, this.scene);
    root.position.set(x, 0, z);
    root.rotation.y = rotY;
    walls.parent = root;
    this.register(walls, "world", true, true);
    this.glaze(`house${i}`, root, specs);

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
      projectUV(slab, 2);
      slab.material = roofMat;
      this.register(slab, "world", false, true);
    }
    // Пол (в доме с подвалом — с вырезом под люк)
    if (i === CELLAR.house) {
      this.buildCellar(root, x, z, w, d);
    } else {
      const floor = MeshBuilder.CreateGround(`floor${i}`, { width: w - 0.4, height: d - 0.4 }, this.scene);
      floor.parent = root;
      floor.position.y = 0.03;
      floor.material = this.mWoodDark;
      this.register(floor, null, false);
    }
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
    const kinds: CarKind[] = ["sedan", "suv", "pickup", "sedan", "suv", "sedan"];
    const car = buildCarMesh(this.scene, `car${i}`, kinds[i % kinds.length], color);
    car.position.set(x, 0, z);
    // Модель вытянута вдоль x, а раскладка задаёт «перёд» по z
    car.rotation.y = rotY - Math.PI / 2;
    car.computeWorldMatrix(true);
    car.receiveShadows = true;
    this.register(car, "world", true, true);
    // Ездит: коллизии — эллипсоид по размеру кузова
    car.ellipsoid = new Vector3(1.3, 0.75, 1.3);
    car.ellipsoidOffset = new Vector3(0, 0.75, 0);
    this.staticMeshes.splice(this.staticMeshes.indexOf(car), 1);
    this.cars.push({ mesh: car, yaw: rotY, home: car.position.clone(), homeYaw: rotY });
    this.covers.push({ x, z, r: 2.6 });
    this.obstacles.push({ x0: x - 2.6, z0: z - 2.6, x1: x + 2.6, z1: z + 2.6 });
  }

  private buildVillage(ox = 0, oz = 0): void {
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
    houses.forEach(([x, z, r], i) => this.buildHouse(i, x + ox, z + oz, r));

    const cars: [number, number, number, string][] = [
      [-22, -1.4, Math.PI / 2, "#2f6fd6"],
      [18, -1.4, -Math.PI / 2, "#e8e8e8"],
      [-6, 5.6, Math.PI / 2, "#d6b02f"],
      [7.5, -14, 0, "#b8322a"],
      [31, 5.6, Math.PI / 2, "#3f8f8a"],
      [-36, 5.6, -Math.PI / 2, "#3b4a3f"],
    ];
    cars.forEach(([x, z, r, c], i) => this.buildCar(i, x + ox, z + oz, r, c));

    // Немного сена и кустов у домов
    this.placeHayRound(-20 + ox, 15 + oz, 0.3);
    this.placeHayRound(18 + ox, 15 + oz, 1.2);
    this.placeHaySquare(-2 + ox, -16 + oz, 0.2);
    this.placeHaySquare(27 + ox, -3 + oz, 1.0);
    for (let i = 0; i < 26; i++) {
      const p = this.findFree(-38 + ox, -24 + oz, 38 + ox, 28 + oz, 1.2);
      if (p) this.placeBush(p.x, p.z);
    }
  }

  // ---------- Лес ----------


  /** Отдельный генератор для выбора моделей и декора, чтобы не сдвигать раскладку карты */
  private rngLook = makeRng(4242);
  private trunkCollider: Mesh | null = null;
  private treeBases: TreeBases | null = null;

  private trees(): TreeBases {
    if (!this.treeBases) this.treeBases = buildTreeBases(this.scene, this.detail, this.level === 4);
    return this.treeBases;
  }

  private placeTree(x: number, z: number): void {
    const pine = this.rng() < 0.55;
    const s = 0.8 + this.rng() * 0.5;
    const rot = this.rng() * Math.PI * 2;
    const pick = this.rngLook();
    const tb = this.trees();
    const list = pine ? tb.pine : tb.broad;
    const base = list[Math.floor(pick * list.length) % list.length];
    const tree = base.createInstance(`tree_${x}_${z}`);
    tree.position.set(x, this.heightAt(x, z), z);
    tree.scaling.setAll(0.75 * s);
    tree.rotation.y = rot;
    // Крона закрывает обзор, но пули через неё летят
    this.register(tree, "soft", false, true);

    // Ствол — невидимый цилиндр: в него упираешься и в него попадают пули
    if (!this.trunkCollider) {
      const c = MeshBuilder.CreateCylinder("trunkCollider", { diameter: 0.5, height: 3, tessellation: 6 }, this.scene);
      c.position.y = 1.5;
      c.bakeCurrentTransformIntoVertices();
      c.isVisible = false;
      c.isPickable = false;
      this.trunkCollider = c;
    }
    this.treeSpots.push(new Vector3(x, 0, z));
    const trunk = this.trunkCollider.createInstance(`trunk_${x}_${z}`);
    trunk.position.set(x, this.heightAt(x, z), z);
    trunk.scaling.set(s, 1, s);
    trunk.isVisible = false;
    this.register(trunk, "world", true);
    const rect = { x0: x - 1.2, z0: z - 1.2, x1: x + 1.2, z1: z + 1.2 };
    this.obstacles.push(rect);
    this.treeList.push({ pos: new Vector3(x, this.heightAt(x, z), z), mesh: tree, trunk, rect, rot, pine, hp: TREE_HP, fallT: 0, fallDir: 0 });
  }

  // ---------- Уровень 5: гонки ----------

  private buildLevel5(): void {
    this.buildBorder();
    // Осевая линия: замкнутая сглаженная кривая по опорным точкам (Катмулл–Ром)
    const ctrl: [number, number][] = [
      [-62, -76], [0, -78], [50, -75], [82, -50], [86, 0], [70, 45], [36, 62], [6, 34], [-24, 60], [-64, 72], [-86, 30], [-84, -36],
    ];
    const C = ctrl.map(([x, z]) => new Vector3(x, 0, z));
    const n = C.length;
    const per = 48;
    const pts: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = C[(i - 1 + n) % n], p1 = C[i], p2 = C[(i + 1) % n], p3 = C[(i + 2) % n];
      for (let k = 0; k < per; k++) pts.push(Vector3.CatmullRom(p0, p1, p2, p3, k / per));
    }
    const N = pts.length;
    const tan = pts.map((_, i) => pts[(i + 1) % N].subtract(pts[(i - 1 + N) % N]).normalize());
    const width = 14;
    // Старт — на прямой внизу карты, x ≈ -24; машины ждут в пещере позади
    let startIdx = 0;
    let best = 1e9;
    for (let i = 0; i < per * 2; i++) {
      const d = Math.abs(pts[i].x + 24) + Math.abs(pts[i].z + 77) * 0.2;
      if (d < best) {
        best = d;
        startIdx = i;
      }
    }
    const cps: number[] = [];
    for (let k = 0; k < 12; k++) cps.push((startIdx + Math.round((k * N) / 12)) % N);
    const back = (k: number) => pts[(startIdx - k + N) % N];
    const grid: Track["grid"] = [];
    for (let r = 0; r < 2; r++) {
      for (const side of [-1, 1]) {
        const i = (startIdx - 14 - r * 9 + N) % N;
        const t = tan[i];
        const right = new Vector3(t.z, 0, -t.x);
        grid.push({ pos: pts[i].add(right.scale(side * 3)), yaw: Math.atan2(t.x, t.z) });
      }
    }
    this.track = { pts, tan, width, startIdx, cps, grid };

    // Асфальт: лента вдоль осевой, текстура по пройденному пути
    const asphalt = photoMat(this.scene, "asphalt", "#9a9a9a");
    const ribbon = (name: string, w0: number, w1: number, y: number, mat: StandardMaterial, vScale: number) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      let dist = 0;
      for (let i = 0; i <= N; i++) {
        const p = pts[i % N];
        const t = tan[i % N];
        const right = new Vector3(t.z, 0, -t.x);
        if (i > 0) dist += Vector3.Distance(pts[i - 1], p);
        const a = p.add(right.scale(w0));
        const b = p.add(right.scale(w1));
        pos.push(a.x, y, a.z, b.x, y, b.z);
        uv.push(0, dist / vScale, (w1 - w0) / vScale, dist / vScale);
        if (i < N) {
          const q = i * 2;
          idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
        }
      }
      const vd = new VertexData();
      vd.positions = pos;
      vd.indices = idx;
      vd.uvs = uv;
      const nrm: number[] = [];
      VertexData.ComputeNormals(pos, idx, nrm);
      // Лента может оказаться «вывернутой» — нормали всегда вверх
      for (let k = 0; k < nrm.length; k += 3) {
        nrm[k] = 0;
        nrm[k + 1] = 1;
        nrm[k + 2] = 0;
      }
      vd.normals = nrm;
      const m = new Mesh(name, this.scene);
      vd.applyToMesh(m);
      m.material = mat;
      m.material.backFaceCulling = false;
      m.receiveShadows = true;
      this.register(m, null, false);
      return m;
    };
    ribbon("track", -width / 2, width / 2, 0.03, asphalt, 8);
    // Бордюры: красно-белые полосы по краям
    const kerbTex = new DynamicTexture("kerbTex", { width: 64, height: 64 }, this.scene, false);
    const kc = kerbTex.getContext() as CanvasRenderingContext2D;
    kc.fillStyle = "#d42a20";
    kc.fillRect(0, 0, 64, 32);
    kc.fillStyle = "#f4f4f4";
    kc.fillRect(0, 32, 64, 32);
    kerbTex.update();
    const kerb = new StandardMaterial("kerbMat", this.scene);
    kerb.diffuseTexture = kerbTex;
    kerb.specularColor.set(0.1, 0.1, 0.1);
    ribbon("kerbL", -width / 2 - 1, -width / 2, 0.05, kerb, 3);
    ribbon("kerbR", width / 2, width / 2 + 1, 0.05, kerb, 3);
    // Белая разметка по центру — пунктир
    const dash = MeshBuilder.CreateBox("dash", { width: 0.25, height: 0.02, depth: 3 }, this.scene);
    dash.material = flatMat(this.scene, "#eeeeee");
    dash.isPickable = false;
    for (let i = 0; i < N; i += 4) {
      const m = dash.createInstance(`dash${i}`);
      m.position.set(pts[i].x, 0.045, pts[i].z);
      m.rotation.y = Math.atan2(tan[i].x, tan[i].z);
      this.register(m, null, false);
    }
    dash.isVisible = false;
    // Трасса — не место для деревьев и домов
    for (let i = 0; i < N; i += 3) {
      const p = pts[i];
      const r = width / 2 + 3;
      this.obstacles.push({ x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r });
    }

    // Старт/финиш: клетчатая полоса и арка
    const s0 = pts[startIdx];
    const sYaw = Math.atan2(tan[startIdx].x, tan[startIdx].z);
    const checkTex = new DynamicTexture("checkTex", { width: 128, height: 32 }, this.scene, false);
    const cc = checkTex.getContext() as CanvasRenderingContext2D;
    for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) {
      cc.fillStyle = (x + y) % 2 ? "#111" : "#f5f5f5";
      cc.fillRect(x * 8, y * 8, 8, 8);
    }
    checkTex.update();
    const checkMat = new StandardMaterial("checkMat", this.scene);
    checkMat.diffuseTexture = checkTex;
    const line = MeshBuilder.CreateGround("finish", { width: width, height: 1.6 }, this.scene);
    line.position.set(s0.x, 0.06, s0.z);
    line.rotation.y = sYaw;
    line.material = checkMat;
    this.register(line, null, false);
    const right0 = new Vector3(tan[startIdx].z, 0, -tan[startIdx].x);
    for (const side of [-1, 1]) {
      const post = MeshBuilder.CreateBox("archPost", { width: 0.6, height: 7, depth: 0.6 }, this.scene);
      const at = s0.add(right0.scale(side * (width / 2 + 1.5)));
      post.position.set(at.x, 3.5, at.z);
      post.material = flatMat(this.scene, "#d42a20");
      this.register(post, "world", true, true);
    }
    const banner = MeshBuilder.CreateBox("archTop", { width: width + 4, height: 1.4, depth: 0.5 }, this.scene);
    banner.position.set(s0.x, 7, s0.z);
    banner.rotation.y = sYaw + Math.PI / 2;
    banner.material = checkMat;
    this.register(banner, "world", false, true);

    // Пещера, из которой стартуют: каменный свод над трассой позади старта
    const caveFrom = 8;
    const caveTo = 44;
    // Свод — полуэллипс над дорогой, протянутый вдоль трассы
    {
      const J = 18;
      const Rw = width / 2 + 3.5;
      const Rh = 7;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      let dist = 0;
      let rows = 0;
      for (let k = caveTo; k >= caveFrom; k--) {
        const i = (startIdx - k + N) % N;
        const p = pts[i];
        const t = tan[i];
        const right = new Vector3(t.z, 0, -t.x);
        if (rows > 0) dist += 1.05;
        for (let j = 0; j <= J; j++) {
          const a = (Math.PI * j) / J;
          // Неровный камень: радиус чуть «дышит»
          const wob = 1 + 0.06 * Math.sin(j * 2.3 + k * 0.7);
          const v = p.add(right.scale(Math.cos(a) * Rw * wob));
          pos.push(v.x, Math.sin(a) * Rh * wob, v.z);
          uv.push((j / J) * 5, dist / 5);
        }
        if (rows > 0) {
          const a0 = (rows - 1) * (J + 1);
          const b0 = rows * (J + 1);
          for (let j = 0; j < J; j++) idx.push(a0 + j, b0 + j, a0 + j + 1, a0 + j + 1, b0 + j, b0 + j + 1);
        }
        rows++;
      }
      const vd = new VertexData();
      vd.positions = pos;
      vd.indices = idx;
      vd.uvs = uv;
      const nrm: number[] = [];
      VertexData.ComputeNormals(pos, idx, nrm);
      vd.normals = nrm;
      const cave = new Mesh("cave", this.scene);
      vd.applyToMesh(cave);
      const caveMat = photoMat(this.scene, "aerial_grass_rock", "#7a746e");
      cave.material = caveMat;
      caveMat.backFaceCulling = false;
      caveMat.twoSidedLighting = true;
      this.register(cave, "world", false, true);
      // Стены пещеры держат машины на трассе
      for (let k = caveFrom; k <= caveTo; k += 2) {
        const i = (startIdx - k + N) % N;
        const t = tan[i];
        const right = new Vector3(t.z, 0, -t.x);
        for (const side of [-1, 1]) {
          const wall = MeshBuilder.CreateBox(`caveWall${k}${side}`, { width: 1, height: 4, depth: 2.8 }, this.scene);
          const at = pts[i].add(right.scale(side * (Rw - 0.6)));
          wall.position.set(at.x, 2, at.z);
          wall.rotation.y = Math.atan2(t.x, t.z);
          wall.isVisible = false;
          this.register(wall, "world", true);
        }
      }
    }
    // Задняя стена пещеры
    {
      const i = (startIdx - caveTo - 1 + N) % N;
      const p = pts[i];
      const back = MeshBuilder.CreateBox("caveBack", { width: width + 8, height: 8, depth: 1.5 }, this.scene);
      back.position.set(p.x, 3, p.z);
      back.rotation.y = Math.atan2(tan[i].x, tan[i].z);
      back.material = photoMat(this.scene, "aerial_grass_rock", "#7a746e");
      this.register(back, "world", true, true);
      // Камни вокруг входа — пещера в скале
      for (let k = caveFrom; k <= caveTo + 2; k += 5) {
        const q = back.position;
        void q;
        const j = (startIdx - k + N) % N;
        const tt = tan[j];
        const rr = new Vector3(tt.z, 0, -tt.x);
        for (const side of [-1, 1]) {
          const at = pts[j].add(rr.scale(side * (width / 2 + 7 + this.rng() * 3)));
          this.placeStone(at.x, at.z);
        }
      }
    }
    void back;

    // Трибуны со зрителями вдоль стартовой прямой (снаружи)
    this.buildStands(startIdx + 10, 60, width);

    // Свои домики вокруг трассы
    const houses: [number, number, number][] = [
      [20, -30, 0], [-40, 0, Math.PI / 2], [40, 15, Math.PI], [-50, 35, 0], [60, -10, -Math.PI / 2],
    ];
    houses.forEach(([x, z, r], i) => {
      if (this.isFree(x, z, 6)) this.buildHouse(i % 3, x, z, r);
    });

    // Баз нет: точки появления — места на старте
    const dummy = (clan: ClanId, i: number): BaseInfo => {
      const flag = MeshBuilder.CreatePlane(`noflag_${clan}`, { size: 0.01 }, this.scene);
      flag.isVisible = false;
      const g = grid[i];
      return { clan, center: g.pos.clone(), spawns: [g.pos.clone()], facing: g.yaw, flagPoint: new Vector3(999, 0, 999), flag };
    };
    this.bases = { dragons: dummy("dragons", 0), snakes: dummy("snakes", 1) };
    // Машина игрока — первая на старте
    this.buildCar(0, grid[0].pos.x, grid[0].pos.z, grid[0].yaw, "#d22f27");
    // Сундуки с патронами у обочин
    for (let k = 1; k < 12; k += 2) {
      const i = cps[k];
      const t = tan[i];
      const right = new Vector3(t.z, 0, -t.x);
      this.ammoSpots.push(pts[i].add(right.scale(k % 4 === 1 ? 4 : -4)));
    }
    // Лес и кусты вокруг
    for (let i = 0; i < 120; i++) {
      const p = this.findFree(-96, -96, 96, 96, 2);
      if (p) this.placeTree(p.x, p.z);
    }
    for (let i = 0; i < 50; i++) {
      const p = this.findFree(-96, -96, 96, 96, 1.2);
      if (p) this.placeBush(p.x, p.z);
    }
  }

  /** Трибуны: ступени с пёстрыми зрителями и навесом */
  private buildStands(fromIdx: number, len: number, width: number): void {
    const tr = this.track!;
    const N = tr.pts.length;
    const i = (fromIdx + Math.round(len / 2 / 1.2)) % N;
    const p = tr.pts[i];
    const t = tr.tan[i];
    const yaw = Math.atan2(t.x, t.z);
    const right = new Vector3(t.z, 0, -t.x);
    // Трибуна слева по ходу (снаружи стартовой прямой — к краю карты)
    const out = p.z < 0 ? (right.z < 0 ? right : right.scale(-1)) : right;
    const base = p.add(out.scale(width / 2 + 6));
    const steps = 5;
    const concrete = this.mConcrete;
    for (let k = 0; k < steps; k++) {
      const step = MeshBuilder.CreateBox(`stand${k}`, { width: len, height: 0.6 * (k + 1), depth: 1.6 }, this.scene);
      const at = base.add(out.scale(k * 1.6));
      step.position.set(at.x, 0.3 * (k + 1), at.z);
      step.rotation.y = yaw + Math.PI / 2;
      step.material = concrete;
      this.register(step, "world", true, true);
    }
    // Зрители: тонкие экземпляры с разными цветами
    const fan = MeshBuilder.CreateBox("fan", { width: 0.45, height: 0.9, depth: 0.35 }, this.scene);
    fan.material = flatMat(this.scene, "#ffffff");
    fan.isPickable = false;
    const head = MeshBuilder.CreateSphere("fanHead", { diameter: 0.3, segments: 6 }, this.scene);
    head.position.y = 0.6;
    const fanMesh = Mesh.MergeMeshes([fan, head], true)!;
    fanMesh.material = flatMat(this.scene, "#ffffff");
    const mats: number[] = [];
    const cols: number[] = [];
    const palette = ["#e53935", "#1e88e5", "#fdd835", "#43a047", "#fb8c00", "#8e24aa", "#ffffff", "#212121"];
    const along = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    for (let k = 0; k < steps; k++) {
      for (let s = -len / 2 + 1; s < len / 2 - 1; s += 0.8) {
        if (this.rng() < 0.25) continue;
        const at = base.add(out.scale(k * 1.6 + 0.2)).add(along.scale(s + (this.rng() - 0.5) * 0.3));
        const y = 0.6 * (k + 1) + 0.45;
        const m = Matrix.RotationY(yaw + Math.PI + (this.rng() - 0.5) * 0.6).multiply(Matrix.Translation(at.x, y, at.z));
        mats.push(...m.asArray());
        const c = Color3.FromHexString(palette[Math.floor(this.rng() * palette.length)]);
        cols.push(c.r, c.g, c.b, 1);
      }
    }
    fanMesh.thinInstanceSetBuffer("matrix", new Float32Array(mats), 16);
    fanMesh.thinInstanceSetBuffer("color", new Float32Array(cols), 4);
    fanMesh.isPickable = false;
    this.fans = fanMesh;
    // Навес на столбах
    const roof = MeshBuilder.CreateBox("standRoof", { width: len + 2, height: 0.3, depth: steps * 1.6 + 2 }, this.scene);
    const rc = base.add(out.scale(((steps - 1) * 1.6) / 2));
    roof.position.set(rc.x, 0.6 * steps + 3.4, rc.z);
    roof.rotation.y = yaw + Math.PI / 2;
    roof.material = photoMat(this.scene, "corrugated_iron");
    this.register(roof, "world", false, true);
    for (const s of [-len / 2, 0, len / 2]) {
      const pp = base.add(out.scale(steps * 1.6)).add(along.scale(s));
      const post = MeshBuilder.CreateBox("standPost", { width: 0.3, height: 0.6 * steps + 3.4, depth: 0.3 }, this.scene);
      post.position.set(pp.x, (0.6 * steps + 3.4) / 2, pp.z);
      post.material = concrete;
      this.register(post, "world", true, true);
    }
    this.obstacles.push({ x0: Math.min(base.x, rc.x) - len / 2 - 4, z0: Math.min(base.z, rc.z) - 10, x1: Math.max(base.x, rc.x) + len / 2 + 4, z1: Math.max(base.z, rc.z) + 10 });
  }

  /** Ещё деревья по всей карте (Даниэль: «нужна природа, больше деревьев») */
  private extraTrees(): void {
    const n = { 1: 45, 2: 90, 3: 10, 4: 25 }[this.level] ?? 0;
    const H = MAP_HALF - 4;
    for (let i = 0; i < Math.round(n * Math.min(1, this.detail + 0.2)); i++) {
      const p = this.findFree(-H, -H, H, H, 2.5);
      if (p) this.placeTree(p.x, p.z);
    }
  }

  /** Удар по дереву. Возвращает true, если от этого удара оно начало падать */
  chopTree(t: TreeInfo, fromYaw: number): boolean {
    if (t.fallT > 0) return false;
    t.hp--;
    if (t.hp > 0) return false;
    t.fallT = 0.0001;
    t.fallDir = fromYaw;
    t.mesh.unfreezeWorldMatrix();
    t.mesh.rotation.y = fromYaw;
    t.trunk.setEnabled(false);
    t.rect.x1 = t.rect.x0;
    t.rect.z1 = t.rect.z0;
    return true;
  }

  /** Падающие деревья: наклон с ускорением, удар о землю, потом исчезают; через минуту вырастают снова */
  updateTrees(dt: number): { landed: Vector3[] } {
    const landed: Vector3[] = [];
    for (const t of this.treeList) {
      if (t.fallT <= 0) continue;
      const prev = t.fallT;
      t.fallT += dt;
      const k = Math.min(1, (t.fallT / 1.4) ** 2);
      t.mesh.rotation.x = k * (Math.PI / 2 - 0.08);
      if (prev < 1.4 && t.fallT >= 1.4) landed.push(t.pos.add(new Vector3(Math.sin(t.fallDir) * 3, 0.5, Math.cos(t.fallDir) * 3)));
      if (t.fallT > 9) t.mesh.setEnabled(false);
      if (t.fallT > 60) this.regrowTree(t);
    }
    return { landed };
  }

  regrowTree(t: TreeInfo): void {
    t.fallT = 0;
    t.hp = TREE_HP;
    t.mesh.rotation.set(0, t.rot, 0);
    t.mesh.setEnabled(true);
    t.trunk.setEnabled(true);
    t.rect.x1 = t.rect.x0 + 2.4;
    t.rect.z1 = t.rect.z0 + 2.4;
  }

  private placeBush(x: number, z: number): void {
    const s = 0.8 + this.rng() * 0.5;
    const rot = this.rng() * 3;
    this.rngLook();
    const inst = this.trees().bush.createInstance(`bush_${x}_${z}`);
    inst.position.set(x, this.heightAt(x, z), z);
    // Куст ~1.2 м в высоту и ~2 м в ширину: за ним можно присесть и спрятаться
    inst.scaling.setAll(s);
    inst.rotation.y = rot;
    // Через куст можно пройти и спрятаться; он закрывает обзор, но не пули
    this.register(inst, "soft", false);
    this.covers.push({ x, z, r: 1.3 * s + 0.4 });
    this.obstacles.push({ x0: x - 1.2, z0: z - 1.2, x1: x + 1.2, z1: z + 1.2 });
  }

  /** Валуны: твёрдые, за ними можно укрыться от пуль */
  private placeStone(x: number, z: number): void {
    const r = this.rngLook;
    const tall = r() < 0.3;
    const id: NatureId = tall ? "stone_tallB" : r() < 0.5 ? "stone_largeA" : "stone_largeC";
    const s = 0.8 + r() * 0.6;
    const inst = getModels().nature(id).createInstance(`stone_${x}_${z}`);
    inst.position.set(x, this.heightAt(x, z) - 0.05, z);
    // Модель уже в своих пропорциях: низкий валун ~3 м в ширину, высокий ~1.8 м в высоту
    inst.scaling.setAll((tall ? 1.8 : 0.8) * s);
    inst.rotation.y = r() * Math.PI * 2;
    this.register(inst, "world", true, true);
    this.covers.push({ x, z, r: 1.6 * s });
    this.obstacles.push({ x0: x - 1.6, z0: z - 1.6, x1: x + 1.6, z1: z + 1.6 });
  }

  /**
   * Мелкие детали без столкновений: цветы, трава, грибы, пни, брёвна.
   * Ставятся в самом конце и собственным генератором — на раскладку не влияют.
   */
  private scatterDecor(detail: number): void {
    const r = this.rngLook;
    const decor: [NatureId | "grass", number, number][] = [
      // модель, сколько штук на полной детализации, масштаб (для травы — множитель к 1×0.5 м)
      ["grass", 420, 1.0],
      ["stump_round", 18, 0.45],
      ["log", 12, 0.4],
    ];
    for (const [id, count, h] of decor) {
      // Тонкие экземпляры: вся россыпь одной модели — одна сетка и один вызов отрисовки,
      // без проверки видимости каждой травинки на процессоре
      const base = id === "grass" ? grassTuftMesh(this.scene) : getModels().nature(id);
      const n = Math.round(count * detail);
      const matrices: Matrix[] = [];
      for (let i = 0; i < n; i++) {
        const x = (r() * 2 - 1) * (MAP_HALF - 3);
        const z = (r() * 2 - 1) * (MAP_HALF - 3);
        if (!this.isFree(x, z, 0.3)) continue;
        if (this.noDecor.some((q) => inRect(q, x, z))) continue;
        const sc = h * (0.75 + r() * 0.5);
        matrices.push(Matrix.Compose(new Vector3(sc, sc, sc), Quaternion.RotationYawPitchRoll(r() * Math.PI * 2, 0, 0), new Vector3(x, this.heightAt(x, z), z)));
      }
      if (!matrices.length) continue;
      const buf = new Float32Array(matrices.length * 16);
      matrices.forEach((m, i) => m.copyToArray(buf, i * 16));
      base.thinInstanceSetBuffer("matrix", buf, 16, true);
      base.thinInstanceRefreshBoundingInfo(false);
      base.isVisible = true;
      base.isPickable = false;
      base.freezeWorldMatrix();
    }
  }

  private buildStones(): void {
    // Валуны в лесу, на поле и вдоль дорог за деревней
    for (let i = 0; i < 14; i++) {
      const p = this.findFree(-62, 16, -10, 62, 2.5);
      if (p) this.placeStone(p.x, p.z);
    }
    for (let i = 0; i < 10; i++) {
      const p = this.findFree(-62, -62, 62, 62, 3);
      if (p) this.placeStone(p.x, p.z);
    }
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
    return photoMat(this.scene, "reed_roof_04", "#f0d890");
  }

  private placeHayRound(x: number, z: number, rot: number): void {
    const c = MeshBuilder.CreateCylinder(`hayR_${x}_${z}`, { diameter: 1.6, height: 1.3, tessellation: 12 }, this.scene);
    c.rotation.set(0, rot, Math.PI / 2);
    c.position.set(x, 0.8, z);
    projectUV(c, 1.2);
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
    projectUV(b, 1.2);
    b.material = this.hayMat();
    this.register(b, "world", true, true);
    if (this.rng() < 0.5) {
      const top = MeshBuilder.CreateBox(`hayS2_${x}_${z}`, { width: 1.2, height: 0.9, depth: 1.1 }, this.scene);
      top.rotation.y = rot;
      top.position.set(x, 1.35, z);
      projectUV(top, 1.2);
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
    projectUV(field, 6);
    field.material = photoMat(this.scene, "withered_grass");
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

  // ---------- Уровень 2: большая карта с биомами ----------

  private buildLevel2(): void {
    const V = VILLAGE2;
    // Дороги: крест через центр (упирается в главное здание) и улицы деревни
    this.buildRoads([
      { x0: -82, z0: -2, x1: -12, z1: 2 },
      { x0: 12, z0: -2, x1: 82, z1: 2 },
      { x0: -2, z0: -95, x1: 2, z1: -9 },
      { x0: -2, z0: 9, x1: 2, z1: 95 },
      { x0: -46 + V.x, z0: V.z, x1: -2, z1: 4 + V.z }, // главная улица деревни → к центральной дороге
      { x0: 1 + V.x, z0: -34 + V.z, x1: 5 + V.x, z1: 34 + V.z }, // поперечная
    ]);
    this.buildBorder();
    this.bases = {
      dragons: this.buildBase("dragons", -88, 0, Math.PI / 2, Math.PI / 2),
      snakes: this.buildBase("snakes", 88, 0, -Math.PI / 2, -Math.PI / 2),
    };
    this.buildMainBuilding(0, 0);
    this.buildVillage(V.x, V.z);
    this.buildMountain();
    this.buildFactory(-58, -58);
    // Лес — северо-восточный угол
    for (let i = 0; i < 160; i++) {
      const p = this.findFree(12, 12, 96, 96, 1.6);
      if (p) this.placeTree(p.x, p.z);
    }
    for (let i = 0; i < 70; i++) {
      const p = this.findFree(12, 12, 96, 96, 1.0);
      if (p) this.placeBush(p.x, p.z);
    }
    // Немного деревьев по всей карте
    for (let i = 0; i < 40; i++) {
      const p = this.findFree(-96, -96, 96, 96, 3);
      if (p) this.placeTree(p.x, p.z);
    }
    // Патроны по биомам
    const zones: [number, number, number, number][] = [
      [-90, 20, -10, 90], [-90, 20, -10, 90], [-90, 20, -10, 90], // деревня
      [15, 15, 90, 90], [15, 15, 90, 90], // лес
      [25, -90, 90, -25], [25, -90, 90, -25], // гора
      [-90, -90, -25, -25], [-90, -90, -25, -25], // завод
      [-15, -15, 15, 15], [-30, -30, 30, 30], [-95, -95, 95, 95], [-95, -95, 95, 95], [-95, -95, 95, 95],
    ];
    for (const [x0, z0, x1, z1] of zones) {
      const p = this.findFree(x0, z0, x1, z1, 1);
      if (p) {
        this.ammoSpots.push(new Vector3(p.x, this.heightAt(p.x, p.z), p.z));
        this.obstacles.push({ x0: p.x - 1, z0: p.z - 1, x1: p.x + 1, z1: p.z + 1 });
      }
    }
    // Валуны по всей карте
    for (let i = 0; i < 26; i++) {
      const p = this.findFree(-96, -96, 96, 96, 3);
      if (p) this.placeStone(p.x, p.z);
    }
  }

  // ---------- Уровень 4: снег, каждый сам за себя ----------

  private buildLevel4(): void {
    this.buildBorder();
    // Четыре угла — четыре бойца
    const c = 38;
    for (const [x, z] of [[-c, -c], [c, c], [-c, c], [c, -c]]) this.ffaSpawns.push(new Vector3(x, 0, z));
    // Баз и флагов нет: заглушки с точками появления, чтобы общий код возрождения работал
    const dummy = (clan: ClanId, i: number): BaseInfo => {
      const flag = MeshBuilder.CreatePlane(`noflag_${clan}`, { size: 0.01 }, this.scene);
      flag.isVisible = false;
      const sp = this.ffaSpawns[i];
      return { clan, center: sp.clone(), spawns: [sp.clone()], facing: Math.atan2(-sp.x, -sp.z), flagPoint: new Vector3(999, 0, 999), flag };
    };
    this.bases = { dragons: dummy("dragons", 0), snakes: dummy("snakes", 1) };
    for (const sp of this.ffaSpawns) this.obstacles.push({ x0: sp.x - 4, z0: sp.z - 4, x1: sp.x + 4, z1: sp.z + 4 });
    // Две избушки в центре — укрытие
    this.buildHouse(0, -7, 0, Math.PI / 2);
    this.buildHouse(1, 9, 3, -Math.PI / 2);
    // Сугробы: снежные бугры, в которых вязнешь
    const driftMat = photoMat(this.scene, "snow_field_aerial", "#ffffff");
    for (let i = 0; i < 9; i++) {
      const p = this.findFree(-44, -44, 44, 44, 4);
      if (!p) continue;
      const r = 3 + this.rng() * 2.5;
      const m = MeshBuilder.CreateSphere(`drift${i}`, { diameterX: r * 2, diameterY: 1.4, diameterZ: r * 2, segments: 12 }, this.scene);
      m.position.set(p.x, -0.15, p.z);
      projectUV(m, 3);
      m.material = driftMat;
      m.receiveShadows = true;
      this.register(m, null, false);
      this.drifts.push({ x: p.x, z: p.z, r });
      this.obstacles.push({ x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r });
    }
    // Заснеженный лес и камни
    for (let i = 0; i < 70; i++) {
      const p = this.findFree(-46, -46, 46, 46, 2.2);
      if (p) this.placeTree(p.x, p.z);
    }
    for (let i = 0; i < 25; i++) {
      const p = this.findFree(-46, -46, 46, 46, 1.2);
      if (p) this.placeBush(p.x, p.z);
    }
    for (let i = 0; i < 10; i++) {
      const p = this.findFree(-46, -46, 46, 46, 2.5);
      if (p) this.placeStone(p.x, p.z);
    }
    for (let i = 0; i < 10; i++) {
      const p = this.findFree(-44, -44, 44, 44, 1);
      if (p) {
        this.ammoSpots.push(new Vector3(p.x, 0, p.z));
        this.obstacles.push({ x0: p.x - 1, z0: p.z - 1, x1: p.x + 1, z1: p.z + 1 });
      }
    }
    // Сугробы остаются проходимыми (иначе в них не провалиться) — убираем их из препятствий для ходьбы
    this.solidRects = null;
  }

  /** Насколько глубоко точка в сугробе: 0 — снаружи, 1 — в центре */
  driftDepth(x: number, z: number): number {
    let best = 0;
    for (const d of this.drifts) {
      const k = 1 - Math.hypot(x - d.x, z - d.z) / d.r;
      if (k > best) best = k;
    }
    return best;
  }

  // ---------- Уровень 3: соло на заводе ----------

  private buildLevel3(): void {
    this.buildBorder();
    this.bases = {
      dragons: this.buildBase("dragons", -36, 36, Math.PI * 0.75, Math.PI * 0.75),
      snakes: this.buildBase("snakes", 36, -36, -Math.PI * 0.25, -Math.PI * 0.25),
    };
    this.buildFactory(0, 0);
    // Немного кустов и валунов по краям — дополнительные укрытия
    for (let i = 0; i < 18; i++) {
      const p = this.findFree(-42, -42, 42, 42, 1.2);
      if (p) this.placeBush(p.x, p.z);
    }
    for (let i = 0; i < 8; i++) {
      const p = this.findFree(-42, -42, 42, 42, 2.5);
      if (p) this.placeStone(p.x, p.z);
    }
    for (let i = 0; i < 12; i++) {
      const p = this.findFree(-42, -42, 42, 42, 1);
      if (p) {
        this.ammoSpots.push(new Vector3(p.x, 0, p.z));
        this.obstacles.push({ x0: p.x - 1, z0: p.z - 1, x1: p.x + 1, z1: p.z + 1 });
      }
    }
  }

  /** Гора: рельеф с хребтами, скальная трава, ели и валуны на склонах; на вершине — обзор */
  private buildMountain(): void {
    const M = MOUNTAIN;
    const size = M.r * 2 + 2;
    const g = MeshBuilder.CreateGround("mountain", { width: size, height: size, subdivisions: 72, updatable: true }, this.scene);
    g.position.set(M.x, 0, M.z);
    g.bakeCurrentTransformIntoVertices();
    const pos = g.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 0; i < pos.length; i += 3) pos[i + 1] = this.heightAt(pos[i], pos[i + 2]) + 0.02;
    g.updateVerticesData(VertexBuffer.PositionKind, pos);
    // Оставляем только треугольники внутри круга горы — без квадратной «заплатки» на земле
    const all = g.getIndices()!;
    const keep: number[] = [];
    for (let i = 0; i < all.length; i += 3) {
      const inside = [all[i], all[i + 1], all[i + 2]].some((v) => Math.hypot(pos[v * 3] - M.x, pos[v * 3 + 2] - M.z) < M.r - 1);
      if (inside) keep.push(all[i], all[i + 1], all[i + 2]);
    }
    g.setIndices(keep);
    const nrm: number[] = [];
    VertexData.ComputeNormals(pos, keep, nrm);
    g.updateVerticesData(VertexBuffer.NormalKind, nrm);
    projectUV(g, 8);
    g.material = photoMat(this.scene, "aerial_grass_rock");
    // На вершине не сажаем ничего, кроме камней
    this.obstacles.push({ x0: M.x - 9, z0: M.z - 9, x1: M.x + 9, z1: M.z + 9 });
    g.receiveShadows = true;
    this.register(g, "world", false);
    for (let i = 0; i < 34; i++) {
      const a = this.rng() * Math.PI * 2;
      // Вершина свободна от деревьев — оттуда обзор на всю карту
      const d = 11 + this.rng() * (M.r - 13);
      const x = M.x + Math.cos(a) * d;
      const z = M.z + Math.sin(a) * d;
      if (this.isFree(x, z, 2)) this.placeTree(x, z);
    }
    for (let i = 0; i < 18; i++) {
      const a = this.rng() * Math.PI * 2;
      const d = 4 + this.rng() * (M.r - 6);
      const x = M.x + Math.cos(a) * d;
      const z = M.z + Math.sin(a) * d;
      if (this.isFree(x, z, 2)) this.placeStone(x, z);
    }
  }

  /** Главное здание в центре карты: бетонный зал с дверями на все четыре стороны */
  private buildMainBuilding(cx: number, cz: number): void {
    const w = 22;
    const d = 16;
    const h = 4.2;
    const root = new TransformNode("mainBuilding", this.scene);
    root.position.set(cx, 0, cz);
    const concrete = photoMat(this.scene, "dirty_concrete", "#e6e6e6");
    const win = (x: number) => ({ x, w: 1.6, b: 1.3, t: 2.8 });
    const door = { x: 0, w: 2.4, b: 0, t: 3.0 };
    const specs: WindowSpec[] = [];
    const walls = this.buildWalls(
      "mainHall",
      w,
      d,
      h,
      concrete,
      [
        [door, win(-7), win(7), win(-3.8), win(3.8)],
        [door, win(-7), win(7), win(-3.8), win(3.8)],
        [door, win(-4.5), win(4.5)],
        [door, win(-4.5), win(4.5)],
      ],
      specs,
    );
    walls.parent = root;
    this.register(walls, "world", true, true);
    this.glaze("mainHall", root, specs);
    const roof = MeshBuilder.CreateBox("mainRoof", { width: w + 0.6, height: 0.35, depth: d + 0.6 }, this.scene);
    roof.parent = root;
    roof.position.y = h + 0.17;
    roof.material = concrete;
    projectUV(roof, 3);
    this.register(roof, "world", true, true);
    const floor = MeshBuilder.CreateBox("mainFloor", { width: w - 0.4, height: 0.05, depth: d - 0.4 }, this.scene);
    floor.parent = root;
    floor.position.y = 0.03;
    floor.material = flatMat(this.scene, "#6f6a62");
    this.register(floor, null, false);
    // Колонны и ящики внутри — укрытия
    for (const [x, z] of [[-5, -3], [5, -3], [-5, 3], [5, 3]]) {
      const c = MeshBuilder.CreateBox("mainCol", { width: 0.7, height: h, depth: 0.7 }, this.scene);
      c.parent = root;
      c.position.set(x, h / 2, z);
      c.material = concrete;
      projectUV(c, 2);
      this.register(c, "world", true, true);
    }
    for (const [x, z] of [[-8, 5.5], [8, -5.5], [0, 5]]) {
      const b = MeshBuilder.CreateBox("mainCrate", { width: 1.4, height: 1.1, depth: 1.4 }, this.scene);
      b.parent = root;
      b.position.set(x, 0.55, z);
      b.material = this.mWood2;
      projectUV(b, 1.5);
      this.register(b, "world", true, true);
    }
    root.computeWorldMatrix(true);
    for (const c of root.getChildMeshes()) c.computeWorldMatrix(true);
    this.obstacles.push({ x0: cx - w / 2 - 2, z0: cz - d / 2 - 2, x1: cx + w / 2 + 2, z1: cz + d / 2 + 2 });
  }

  /** Завод: два цеха из профнастила, труба, контейнеры — много укрытий для перестрелок */
  private buildFactory(cx: number, cz: number): void {
    const iron = photoMat(this.scene, "corrugated_iron", "#d8d8d8");
    const rusty = photoMat(this.scene, "rusty_corrugated_iron");
    const shed = (name: string, x: number, z: number, w: number, d: number, h: number, mat: StandardMaterial) => {
      const root = new TransformNode(name, this.scene);
      root.position.set(x, 0, z);
      const gate = { x: 0, w: 4.5, b: 0, t: 4.2 };
      const win = (px: number) => ({ x: px, w: 2, b: 2.2, t: 3.4 });
      const specs: WindowSpec[] = [];
      const walls = this.buildWalls(name, w, d, h, mat, [[gate, win(-w / 3), win(w / 3)], [gate], [{ x: 0, w: 1.4, b: 0, t: 2.4 }, win(-d / 4)], [win(d / 4)]], specs);
      walls.parent = root;
      this.register(walls, "world", true, true);
      this.glaze(name, root, specs);
      const roof = MeshBuilder.CreateBox(`${name}Roof`, { width: w + 0.8, height: 0.25, depth: d + 0.8 }, this.scene);
      roof.parent = root;
      roof.position.y = h + 0.12;
      roof.material = rusty;
      projectUV(roof, 3);
      this.register(roof, "world", true, true);
      root.computeWorldMatrix(true);
      for (const c of root.getChildMeshes()) c.computeWorldMatrix(true);
      this.obstacles.push({ x0: x - w / 2 - 1.5, z0: z - d / 2 - 1.5, x1: x + w / 2 + 1.5, z1: z + d / 2 + 1.5 });
    };
    shed("factoryA", cx - 4, cz + 8, 26, 14, 6.5, iron);
    shed("factoryB", cx + 14, cz - 12, 14, 10, 5, rusty);
    // Труба
    const chimney = MeshBuilder.CreateCylinder("chimney", { height: 24, diameterTop: 1.8, diameterBottom: 2.8, tessellation: 16 }, this.scene);
    chimney.position.set(cx - 22, 12, cz - 20);
    chimney.material = photoMat(this.scene, "dirty_concrete", "#b9a89a");
    projectUV(chimney, 3);
    this.register(chimney, "world", true, true);
    this.obstacles.push({ x0: cx - 24, z0: cz - 22, x1: cx - 20, z1: cz - 18 });
    // Морские контейнеры, местами в два яруса
    const colors = ["#2f5f9e", "#a8382a", "#3f7f3a", "#c9862a", "#2f5f9e", "#6b6f75"];
    const spots: [number, number, number, boolean][] = [
      [cx - 12, cz - 26, 0.1, true],
      [cx - 4, cz - 28, 0.05, false],
      [cx + 4, cz - 26, 1.57, false],
      [cx - 26, cz - 4, 1.57, true],
      [cx + 26, cz + 6, 0.3, false],
      [cx + 20, cz + 20, 1.2, false],
      [cx - 20, cz + 22, 0.0, true],
      [cx + 6, cz - 2, 0.8, false],
    ];
    spots.forEach(([x, z, rot, stack], i) => {
      for (let lvl = 0; lvl < (stack ? 2 : 1); lvl++) {
        const c = MeshBuilder.CreateBox(`container${i}_${lvl}`, { width: 6, height: 2.6, depth: 2.45 }, this.scene);
        c.position.set(x, 1.3 + lvl * 2.6, z);
        c.rotation.y = rot + lvl * 0.08;
        c.material = photoMat(this.scene, "corrugated_iron", colors[(i + lvl) % colors.length]);
        projectUV(c, 2.5);
        this.register(c, "world", true, true);
      }
      this.covers.push({ x, z, r: 3.2 });
      this.obstacles.push({ x0: x - 3.4, z0: z - 3.4, x1: x + 3.4, z1: z + 3.4 });
    });
    // Бетонная площадка завода
    const pad = MeshBuilder.CreateGround("factoryPad", { width: 64, height: 64 }, this.scene);
    pad.position.set(cx, 0.015, cz);
    projectUV(pad, 5);
    pad.material = photoMat(this.scene, "dirty_concrete", "#9a9a98");
    pad.receiveShadows = true;
    this.register(pad, null, false);
    // На бетоне трава не растёт
    this.noDecor.push({ x0: cx - 32, z0: cz - 32, x1: cx + 32, z1: cz + 32 });
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
