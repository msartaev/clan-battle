import { Color3, Mesh, MeshBuilder, MultiMaterial, Scene, StandardMaterial, SubMesh, Vector3, VertexData } from "@babylonjs/core";

/**
 * Машины деревни: кузов по боковому профилю (седан или внедорожник), стёкла, фары, бамперы,
 * колёса с дисками. Всё сливается в одну сетку с несколькими материалами.
 * Марки вымышленные, как в дизайне.
 */

export type CarKind = "sedan" | "suv" | "pickup";

/** Профиль кузова сбоку: x — вдоль машины (+ вперёд), y — высота; обход по часовой с переднего бампера */
const PROFILES: Record<CarKind, { pts: [number, number][]; glass: number[]; width: number; side: [number, number][] }> = {
  sedan: {
    pts: [
      [2.25, 0.32], [2.3, 0.62], [2.12, 0.8], [0.95, 0.92], [0.32, 1.38], [-0.95, 1.42], [-1.65, 1.0], [-2.2, 0.96], [-2.28, 0.62], [-2.2, 0.32],
    ],
    // Номера рёбер-стёкол (ребро i — от точки i к i+1): лобовое и заднее
    glass: [3, 5],
    width: 1.78,
    side: [[0.8, 0.96], [0.3, 1.33], [-0.92, 1.37], [-1.5, 1.0]],
  },
  suv: {
    pts: [
      [2.2, 0.42], [2.25, 0.8], [2.05, 1.02], [1.0, 1.12], [0.45, 1.72], [-1.85, 1.76], [-2.15, 1.6], [-2.25, 1.05], [-2.25, 0.42],
    ],
    glass: [3, 5],
    width: 1.88,
    side: [[0.88, 1.16], [0.45, 1.67], [-1.8, 1.7], [-1.95, 1.18]],
  },
  pickup: {
    pts: [
      [2.45, 0.45], [2.5, 0.85], [2.3, 1.05], [1.25, 1.12], [0.75, 1.72], [-0.45, 1.74], [-0.55, 1.12], [-2.5, 1.12], [-2.55, 0.45],
    ],
    glass: [3],
    width: 1.9,
    side: [[1.12, 1.16], [0.75, 1.67], [-0.4, 1.68], [-0.45, 1.16]],
  },
};

const mats = new Map<string, StandardMaterial>();
function mat(scene: Scene, key: string, make: () => StandardMaterial): StandardMaterial {
  let m = mats.get(key);
  if (!m || m.getScene() !== scene) {
    m = make();
    mats.set(key, m);
  }
  return m;
}

function paint(scene: Scene, hex: string): StandardMaterial {
  return mat(scene, `paint${hex}`, () => {
    const m = new StandardMaterial(`carPaint${hex}`, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    // Лак: заметный блик
    m.specularColor = new Color3(0.55, 0.55, 0.55);
    m.specularPower = 48;
    return m;
  });
}

/** Корпус: две боковины-веера и лента по периметру профиля; стёкла — отдельный подмеш */
function body(scene: Scene, kind: CarKind): { mesh: Mesh; glassStart: number; glassCount: number } {
  const { pts, glass, width } = PROFILES[kind];
  const hw = width / 2;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idxBody: number[] = [];
  const idxGlass: number[] = [];
  const push = (x: number, y: number, z: number, n: Vector3) => {
    pos.push(x, y, z);
    nrm.push(n.x, n.y, n.z);
    return pos.length / 3 - 1;
  };
  // Боковины: веер из центра профиля (профиль «звёздный» относительно центра)
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  for (const side of [-1, 1]) {
    const n = new Vector3(0, 0, side);
    const c = push(cx, cy, side * hw, n);
    const ring = pts.map(([x, y]) => push(x, y, side * hw, n));
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (side > 0) idxBody.push(c, b, a);
      else idxBody.push(c, a, b);
    }
  }
  // Лента по периметру: капот, стёкла, крыша, багажник, бамперы, днище
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    // Наружная нормаль ребра (обход по часовой — нормаль «влево» от направления)
    const n = new Vector3(y0 - y1, x1 - x0, 0).normalize().scale(-1);
    // Скругление: боковые вершины ленты чуть утоплены внутрь — кузов не выглядит коробкой
    const inset = 0.06;
    const a = push(x0, y0, -hw + inset, n);
    const b = push(x1, y1, -hw + inset, n);
    const c2 = push(x1, y1, hw - inset, n);
    const d = push(x0, y0, hw - inset, n);
    const list = glass.includes(i) ? idxGlass : idxBody;
    list.push(a, c2, b, a, d, c2);
  }
  const m = new Mesh(`carBody_${kind}`, scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.indices = [...idxBody, ...idxGlass];
  // UV не нужны (кузов однотонный), но без них сетки нельзя слить с колёсами и фарами
  vd.uvs = new Array((pos.length / 3) * 2).fill(0);
  vd.applyToMesh(m);
  return { mesh: m, glassStart: idxBody.length, glassCount: idxGlass.length };
}

/** Боковые окна: плоские многоугольники чуть снаружи боковин */
function sideWindows(scene: Scene, kind: CarKind): Mesh {
  const { side, width } = PROFILES[kind];
  const hw = width / 2 + 0.005;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const s of [-1, 1]) {
    const base = pos.length / 3;
    for (const [x, y] of side) {
      pos.push(x, y, s * hw);
      nrm.push(0, 0, s);
    }
    for (let i = 1; i < side.length - 1; i++) {
      if (s > 0) idx.push(base, base + i + 1, base + i);
      else idx.push(base, base + i, base + i + 1);
    }
  }
  const m = new Mesh(`carWin_${kind}`, scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.indices = idx;
  vd.uvs = new Array((pos.length / 3) * 2).fill(0);
  vd.applyToMesh(m);
  return m;
}

export function buildCarMesh(scene: Scene, name: string, kind: CarKind, color: string): Mesh {
  const { pts, width } = PROFILES[kind];
  const front = Math.max(...pts.map((p) => p[0]));
  const rear = Math.min(...pts.map((p) => p[0]));
  const hw = width / 2;

  const glassMat = mat(scene, "glass", () => {
    const m = new StandardMaterial("carGlass", scene);
    m.diffuseColor = new Color3(0.08, 0.11, 0.14);
    m.specularColor = new Color3(0.9, 0.9, 0.9);
    m.specularPower = 96;
    return m;
  });
  const rubber = mat(scene, "rubber", () => {
    const m = new StandardMaterial("carRubber", scene);
    m.diffuseColor = new Color3(0.06, 0.06, 0.06);
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    return m;
  });
  const chrome = mat(scene, "chrome", () => {
    const m = new StandardMaterial("carChrome", scene);
    m.diffuseColor = new Color3(0.62, 0.64, 0.66);
    m.specularColor = new Color3(0.9, 0.9, 0.9);
    m.specularPower = 64;
    return m;
  });
  const lightW = mat(scene, "lightW", () => {
    const m = new StandardMaterial("carLightW", scene);
    m.diffuseColor = new Color3(0.95, 0.95, 0.85);
    m.emissiveColor = new Color3(0.45, 0.45, 0.4);
    return m;
  });
  const lightR = mat(scene, "lightR", () => {
    const m = new StandardMaterial("carLightR", scene);
    m.diffuseColor = new Color3(0.8, 0.08, 0.06);
    m.emissiveColor = new Color3(0.35, 0.02, 0.02);
    return m;
  });
  const paintMat = paint(scene, color);

  const parts: Mesh[] = [];
  const { mesh: bodyMesh, glassStart, glassCount } = body(scene, kind);
  // Подмеши: кузов и лобовое/заднее стекло
  const total = bodyMesh.getTotalIndices();
  bodyMesh.subMeshes = [];
  const verts = bodyMesh.getTotalVertices();
  new SubMesh(0, 0, verts, 0, glassStart, bodyMesh);
  new SubMesh(1, 0, verts, glassStart, glassCount, bodyMesh);
  const mm = new MultiMaterial(`carMM_${name}`, scene);
  mm.subMaterials.push(paintMat, glassMat);
  bodyMesh.material = mm;
  void total;

  const win = sideWindows(scene, kind);
  win.material = glassMat;

  // Колёса: шина + диск, по две оси
  const wheelR = kind === "sedan" ? 0.34 : 0.4;
  const axleF = front - 0.75;
  const axleR = rear + 0.8;
  for (const x of [axleF, axleR]) {
    for (const s of [-1, 1]) {
      const tire = MeshBuilder.CreateCylinder(`tire`, { diameter: wheelR * 2, height: 0.24, tessellation: 18 }, scene);
      tire.rotation.x = Math.PI / 2;
      tire.position.set(x, wheelR, s * (hw - 0.1));
      tire.material = rubber;
      parts.push(tire);
      const rim = MeshBuilder.CreateCylinder(`rim`, { diameter: wheelR * 1.15, height: 0.02, tessellation: 12 }, scene);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(x, wheelR, s * (hw + 0.025));
      rim.material = chrome;
      parts.push(rim);
    }
  }
  // Фары, фонари, бамперы, номер
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: StandardMaterial) => {
    const b = MeshBuilder.CreateBox("part", { width: w, height: h, depth: d }, scene);
    b.position.set(x, y, z);
    b.material = m;
    parts.push(b);
  };
  const frontY = kind === "sedan" ? 0.68 : 0.88;
  for (const s of [-1, 1]) {
    box(0.06, 0.12, 0.34, front + 0.02, frontY, s * (hw - 0.3), lightW);
    box(0.06, 0.12, 0.3, rear - 0.02, frontY, s * (hw - 0.28), lightR);
  }
  box(0.12, 0.16, width - 0.1, front + 0.02, 0.38, 0, rubber);
  box(0.12, 0.16, width - 0.1, rear - 0.02, 0.38, 0, rubber);
  box(0.04, 0.12, 0.5, front + 0.09, 0.52, 0, chrome);
  // Днище темнее, чтобы машина не «висела»
  box(front - rear - 0.6, 0.06, width - 0.2, (front + rear) / 2, 0.3, 0, rubber);

  const merged = Mesh.MergeMeshes([bodyMesh, win, ...parts], true, true, undefined, false, true)!;
  merged.name = name;
  return merged;
}
