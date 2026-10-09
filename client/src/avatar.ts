import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

/**
 * Свой персонаж (идея Даниэля): рисуешь его по клеточкам спереди, а игра делает объёмную фигуру.
 * «Квадратный» — из кубиков, как в Майнкрафте; «круглый» — из шариков, получается мягкая объёмная фигура.
 */

export type AvatarMode = "square" | "round";
export const AV_W = 12;
export const AV_H = 20;

export interface AvatarData {
  mode: AvatarMode;
  /** AV_W × AV_H цветов построчно сверху вниз; "" — пусто */
  cells: string[];
}

export const PALETTE = [
  "#f2c9a0", "#c68b59", "#7a4a2a", "#1d1d1d", "#ffffff", "#9e9e9e",
  "#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa",
];

/** Человечек по умолчанию: голова, тело, руки, ноги — чтобы было с чего начать */
export function defaultAvatar(): AvatarData {
  const cells = new Array(AV_W * AV_H).fill("");
  const put = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * AV_W + x] = c;
  };
  put(4, 0, 7, 1, "#7a4a2a"); // волосы
  put(4, 2, 7, 4, "#f2c9a0"); // лицо
  cells[3 * AV_W + 5] = cells[3 * AV_W + 6] = "#1d1d1d"; // глаза
  put(3, 5, 8, 11, "#e53935"); // куртка
  put(1, 5, 2, 10, "#e53935"); // руки
  put(9, 5, 10, 10, "#e53935");
  put(1, 11, 2, 11, "#f2c9a0"); // кисти
  put(9, 11, 10, 11, "#f2c9a0");
  put(3, 12, 8, 17, "#1e88e5"); // штаны
  put(5, 14, 6, 17, ""); // между ногами
  put(3, 18, 4, 19, "#1d1d1d"); // ботинки
  put(7, 18, 8, 19, "#1d1d1d");
  return { mode: "square", cells };
}

export function loadAvatar(): AvatarData | null {
  try {
    const raw = localStorage.getItem("cb_avatar");
    if (!raw) return null;
    const d = JSON.parse(raw) as AvatarData;
    if (d && Array.isArray(d.cells) && d.cells.length === AV_W * AV_H) return d;
  } catch {
    /* нет хранилища или испорчено */
  }
  return null;
}

export function saveAvatar(d: AvatarData): void {
  try {
    localStorage.setItem("cb_avatar", JSON.stringify(d));
  } catch {
    /* не сохранилось */
  }
}

/**
 * Объёмная фигура по рисунку: каждая клетка — кубик или шарик. Толщина больше в середине
 * (туловище, голова) и меньше по краям (руки) — фигура получается не плоской.
 * Высота фигуры ~1.8 м, ноги стоят на y = 0.
 */
export function buildAvatarMesh(scene: Scene, d: AvatarData, name = "avatar"): Mesh | null {
  const s = 1.8 / AV_H;
  const mats = new Map<string, StandardMaterial>();
  const mat = (c: string) => {
    let m = mats.get(c);
    if (!m) {
      m = new StandardMaterial(`${name}_${c}`, scene);
      m.diffuseColor = Color3.FromHexString(c);
      m.specularColor = new Color3(0.08, 0.08, 0.08);
      mats.set(c, m);
    }
    return m;
  };
  // Сколько клеток в ширину в этой строке — по ней толщина (широкое туловище — толще)
  const parts: Mesh[] = [];
  for (let y = 0; y < AV_H; y++) {
    const row = d.cells.slice(y * AV_W, (y + 1) * AV_W);
    for (let x = 0; x < AV_W; x++) {
      const c = row[x];
      if (!c) continue;
      // Глубина: у «столбиков» (руки, ноги) 1–2 клетки, у широких мест — до 4
      let run = 0;
      for (let k = x; k >= 0 && row[k]; k--) run++;
      for (let k = x + 1; k < AV_W && row[k]; k++) run++;
      const depth = Math.max(2, Math.min(4, Math.round(run / 1.6)));
      const px = (x - AV_W / 2 + 0.5) * s;
      const py = (AV_H - 1 - y + 0.5) * s;
      if (d.mode === "square") {
        const b = MeshBuilder.CreateBox("avBox", { width: s, height: s, depth: s * depth }, scene);
        b.position.set(px, py, 0);
        b.material = mat(c);
        parts.push(b);
      } else {
        // Круглый: шарики чуть больше клетки — сливаются в мягкую объёмную форму
        for (let z = 0; z < depth; z++) {
          const b = MeshBuilder.CreateSphere("avBall", { diameter: s * 1.45, segments: 6 }, scene);
          b.position.set(px, py, (z - (depth - 1) / 2) * s);
          b.material = mat(c);
          parts.push(b);
        }
      }
    }
  }
  if (!parts.length) return null;
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  if (merged) merged.name = name;
  return merged;
}

/** Маленькая 3D-витрина: персонаж медленно крутится (главный экран и рисовалка) */
export class AvatarPreview {
  private engine: Engine;
  private scene: Scene;
  private mesh: Mesh | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, antialias: true });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    const cam = new ArcRotateCamera("avCam", -Math.PI / 2, 1.38, 2.7, new Vector3(0, 0.9, 0), this.scene);
    cam.minZ = 0.1;
    new HemisphericLight("avSky", new Vector3(0, 1, 0), this.scene).intensity = 0.75;
    const sun = new DirectionalLight("avSun", new Vector3(-0.5, -1, 0.8), this.scene);
    sun.intensity = 0.8;
    // Подставка
    const pad = MeshBuilder.CreateCylinder("avPad", { diameter: 1.4, height: 0.06, tessellation: 32 }, this.scene);
    const pm = new StandardMaterial("avPadMat", this.scene);
    pm.diffuseColor = new Color3(0.2, 0.25, 0.32);
    pad.material = pm;
    pad.position.y = -0.03;
    this.engine.runRenderLoop(() => {
      if (this.mesh) this.mesh.rotation.y += this.engine.getDeltaTime() * 0.0008;
      this.scene.render();
    });
    window.addEventListener("resize", this.onResize);
  }

  private onResize = () => this.engine.resize();

  show(d: AvatarData): void {
    const rot = this.mesh?.rotation.y ?? 0;
    this.mesh?.dispose(false, true);
    this.mesh = buildAvatarMesh(this.scene, d, "avPreview");
    if (this.mesh) this.mesh.rotation.y = rot;
    this.engine.resize();
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
