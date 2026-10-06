import { Color3, Material, Mesh, MeshBuilder, Scene, StandardMaterial, Texture, Vector3, VertexData } from "@babylonjs/core";
import { makeRng } from "./utils";

/**
 * Реалистичные деревья «как в играх»: ствол с фото-корой и крона из карточек с прозрачным фоном,
 * на которых настоящие листья (ambientCG, CC0). Нормали карточек смотрят от центра кроны —
 * так крона освещается объёмно, как шар, а не как набор плоскостей.
 * Каждое дерево — одна сетка с двумя материалами; на карте ставятся её экземпляры.
 */

export interface TreeBases {
  broad: Mesh[];
  pine: Mesh[];
  bush: Mesh;
}

function barkMat(scene: Scene, file: string): StandardMaterial {
  const m = new StandardMaterial(`bark_${file}`, scene);
  const t = new Texture(`./textures/${file}.jpg`, scene);
  t.uScale = 2;
  t.vScale = 3;
  m.diffuseTexture = t;
  m.specularColor.set(0.02, 0.02, 0.02);
  return m;
}

function foliageMat(scene: Scene, file: string, tint: string): StandardMaterial {
  const m = new StandardMaterial(`foliage_${file}_${tint}`, scene);
  const t = new Texture(`./textures/${file}.png`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.hasAlpha = true;
  m.diffuseTexture = t;
  m.diffuseColor = Color3.FromHexString(tint);
  // Альфа из текстуры участвует в отсечении (без этого Babylon 9 проверяет только alpha материала)
  m.useAlphaFromDiffuseTexture = true;
  m.transparencyMode = Material.MATERIAL_ALPHATEST;
  m.alphaCutOff = 0.45;
  m.backFaceCulling = false;
  m.twoSidedLighting = true;
  m.specularColor.set(0, 0, 0);
  // Немного собственного света, чтобы теневая сторона кроны не была чёрной
  m.emissiveColor = Color3.FromHexString(tint).scale(0.16);
  return m;
}

/** Набор карточек: копим вершины и сливаем в одну сетку */
class Cards {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  /**
   * Прямоугольная карточка: центр c, оси ширины a и высоты b (полуразмеры уже в векторах),
   * n — нормаль для освещения (от центра кроны)
   */
  add(c: Vector3, a: Vector3, b: Vector3, n: Vector3, u0 = 0, u1 = 1): void {
    const base = this.positions.length / 3;
    const corners: [number, number, number, number][] = [
      [-1, -1, u0, 0],
      [1, -1, u1, 0],
      [1, 1, u1, 1],
      [-1, 1, u0, 1],
    ];
    for (const [sa, sb, u, v] of corners) {
      this.positions.push(c.x + a.x * sa + b.x * sb, c.y + a.y * sa + b.y * sb, c.z + a.z * sa + b.z * sb);
      this.normals.push(n.x, n.y, n.z);
      this.uvs.push(u, v);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  toMesh(name: string, scene: Scene): Mesh {
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.uvs = this.uvs;
    vd.indices = this.indices;
    vd.applyToMesh(m);
    return m;
  }
}

const nrm = (p: Vector3, c: Vector3) => p.subtract(c).normalize();

/** Базис карточки, повёрнутой лицом к n, со случайным поворотом в своей плоскости */
function cardAxes(n: Vector3, size: number, roll: number): [Vector3, Vector3] {
  const helper = Math.abs(n.y) > 0.9 ? Vector3.Right() : Vector3.Up();
  const r = Vector3.Cross(helper, n).normalize();
  const u = Vector3.Cross(n, r).normalize();
  const a = r.scale(Math.cos(roll)).add(u.scale(Math.sin(roll))).scale(size / 2);
  const b = u.scale(Math.cos(roll)).subtract(r.scale(Math.sin(roll))).scale(size / 2);
  return [a, b];
}

function finish(name: string, trunk: Mesh, crown: Mesh, bark: StandardMaterial, leaves: StandardMaterial): Mesh {
  trunk.material = bark;
  crown.material = leaves;
  const m = Mesh.MergeMeshes([trunk, crown], true, true, undefined, false, true)!;
  m.name = name;
  m.isVisible = false;
  m.isPickable = false;
  return m;
}

function trunkMesh(name: string, scene: Scene, h: number, d0: number, d1: number, branches: number, rnd: () => number): Mesh {
  const parts: Mesh[] = [];
  const t = MeshBuilder.CreateCylinder(name, { height: h, diameterBottom: d0, diameterTop: d1, tessellation: 8 }, scene);
  t.position.y = h / 2;
  parts.push(t);
  // Толстые ветви уходят в крону — видны сквозь листья
  for (let i = 0; i < branches; i++) {
    const len = 1.4 + rnd() * 1.2;
    const br = MeshBuilder.CreateCylinder(`${name}_br${i}`, { height: len, diameterBottom: d1 * 0.9, diameterTop: d1 * 0.3, tessellation: 5 }, scene);
    const yaw = (i / branches) * Math.PI * 2 + rnd() * 0.8;
    const tilt = 0.7 + rnd() * 0.4;
    br.position.set(Math.sin(yaw) * Math.sin(tilt) * len * 0.5, h * (0.75 + rnd() * 0.2) + Math.cos(tilt) * len * 0.5, Math.cos(yaw) * Math.sin(tilt) * len * 0.5);
    br.rotation.set(tilt, yaw, 0);
    parts.push(br);
  }
  return Mesh.MergeMeshes(parts, true, true)!;
}

/** Лиственное дерево ~7 м: широкая округлая крона */
function broadTree(scene: Scene, seed: number, bark: StandardMaterial, leaves: StandardMaterial, detail: number): Mesh {
  const rnd = makeRng(seed);
  const trunkH = 3.6 + rnd() * 0.8;
  const trunk = trunkMesh(`broadTrunk${seed}`, scene, trunkH, 0.42, 0.26, 4, rnd);
  const cards = new Cards();
  const center = new Vector3(0, trunkH + 1.3, 0);
  const R = new Vector3(2.5 + rnd() * 0.4, 1.9 + rnd() * 0.3, 2.5 + rnd() * 0.4);
  // Несколько «облаков» листвы вокруг центра, чтобы силуэт был неровным
  const blobs = [center, ...[0, 1, 2].map((k) => center.add(new Vector3(Math.sin(k * 2.1 + seed) * 1.3, (rnd() - 0.3) * 1.0, Math.cos(k * 2.1 + seed) * 1.3)))];
  // На телефонах карточек вдвое меньше, но они крупнее — меньше перерисовки прозрачных пикселей
  const n = Math.round(64 * detail);
  const grow = 1 / Math.sqrt(detail);
  for (let i = 0; i < n; i++) {
    const c0 = blobs[i % blobs.length];
    const dir = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const r = 0.35 + rnd() * 0.65;
    const p = c0.add(new Vector3(dir.x * R.x * r * 0.75, dir.y * R.y * r * 0.75, dir.z * R.z * r * 0.75));
    const face = nrm(p, center).add(new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).scale(0.9)).normalize();
    const [a, b] = cardAxes(face, (1.9 + rnd() * 0.9) * grow, rnd() * Math.PI * 2);
    cards.add(p, a, b, nrm(p, center));
  }
  return finish(`broadTree${seed}`, trunk, cards.toMesh(`broadCrown${seed}`, scene), bark, leaves);
}

/** Ель ~9 м: ярусы лап, свисающих вниз, к верху короче */
function pineTree(scene: Scene, seed: number, bark: StandardMaterial, leaves: StandardMaterial, detail: number): Mesh {
  const rnd = makeRng(seed);
  const H = 8.5 + rnd() * 1.5;
  const trunk = trunkMesh(`pineTrunk${seed}`, scene, H, 0.4, 0.08, 0, rnd);
  const cards = new Cards();
  const bottom = 1.4;
  let tier = 0;
  for (let y = bottom; y < H - 0.6; y += 0.42 / Math.sqrt(detail), tier++) {
    const k = (y - bottom) / (H - bottom);
    const R = 0.35 + 2.6 * (1 - k) ** 1.1;
    const count = Math.max(3, Math.round((9 * (1 - k) + 3) * Math.sqrt(detail)));
    for (let i = 0; i < count; i++) {
      const yaw = (i / count) * Math.PI * 2 + tier * 0.7 + rnd() * 0.5;
      const out = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const droop = 0.25 + rnd() * 0.25;
      // Лапа: от ствола наружу и чуть вниз; u текстуры идёт от основания веточки к кончику
      const along = out.scale(Math.cos(droop)).add(new Vector3(0, -Math.sin(droop), 0));
      const side = Vector3.Cross(Vector3.Up(), out).normalize();
      const c = new Vector3(0, y, 0).add(along.scale(R / 2));
      const n = out.add(new Vector3(0, 0.6, 0)).normalize();
      const width = (R * 0.55 + 0.25) / Math.sqrt(Math.sqrt(detail));
      // Две пересекающиеся плоскости: лапа видна и сверху, и сбоку
      cards.add(c, along.scale(R / 2), side.scale(width / 2), n);
      const tilted = side.scale(0.5).add(new Vector3(0, 0.85, 0)).normalize();
      cards.add(c, along.scale(R / 2), tilted.scale(width / 2.4), n);
    }
  }
  return finish(`pineTree${seed}`, trunk, cards.toMesh(`pineCrown${seed}`, scene), bark, leaves);
}

/** Куст ~1.2 м: полусфера из карточек листвы */
function bushMesh(scene: Scene, leaves: StandardMaterial): Mesh {
  const rnd = makeRng(99);
  const cards = new Cards();
  const center = new Vector3(0, 0.45, 0);
  for (let i = 0; i < 22; i++) {
    const dir = new Vector3(rnd() * 2 - 1, rnd() * 0.9, rnd() * 2 - 1).normalize();
    const p = center.add(new Vector3(dir.x * 0.9, dir.y * 0.55, dir.z * 0.9).scale(0.4 + rnd() * 0.6));
    const n = p.subtract(new Vector3(0, 0, 0)).normalize();
    const [a, b] = cardAxes(n.add(new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)).normalize(), 1.0 + rnd() * 0.5, rnd() * 6.28);
    cards.add(p, a, b, n);
  }
  const m = cards.toMesh("bushCards", scene);
  m.material = leaves;
  m.isVisible = false;
  m.isPickable = false;
  return m;
}

/** @param detail 1 — полная детализация, 0.5 — телефоны и режим ?low */
/** Пучок травы: две перекрещённые карточки 1×0.5 м с настоящими травинками и колосками */
export function grassTuftMesh(scene: Scene): Mesh {
  const leaves = foliageMat(scene, "grass_tuft", "#e2ecd0");
  const cards = new Cards();
  const up = Vector3.Up();
  for (const yaw of [0, Math.PI / 2]) {
    const a = new Vector3(Math.cos(yaw), 0, Math.sin(yaw)).scale(0.5);
    const b = new Vector3(0, 0.25, 0);
    // Нормаль вверх: трава освещается как поверхность земли, без тёмных «боков»
    cards.add(new Vector3(0, 0.25, 0), a, b, up);
  }
  const m = cards.toMesh("grassTuft", scene);
  m.material = leaves;
  m.isPickable = false;
  return m;
}

export function buildTreeBases(scene: Scene, detail = 1): TreeBases {
  // Дальние деревья — упрощённые копии (в 3–4 раза меньше карточек): прозрачные листья дорогие для видеокарты
  const withLod = (near: Mesh, far: Mesh) => {
    far.isVisible = false;
    near.addLODLevel(28, far);
    return near;
  };
  const oakBark = barkMat(scene, "bark_brown_02");
  const pineBark = barkMat(scene, "pine_bark");
  const broadLeaves = foliageMat(scene, "foliage_broad", "#d6e6c0");
  const pineLeaves = foliageMat(scene, "foliage_pine", "#c8d8c0");
  const bushLeaves = foliageMat(scene, "foliage_broad", "#a8c090");
  return {
    broad: [1, 2, 3].map((k) => withLod(broadTree(scene, k, oakBark, broadLeaves, detail), broadTree(scene, k, oakBark, broadLeaves, detail * 0.3))),
    pine: [4, 5].map((k) => withLod(pineTree(scene, k, pineBark, pineLeaves, detail), pineTree(scene, k, pineBark, pineLeaves, detail * 0.3))),
    bush: bushMesh(scene, bushLeaves),
  };
}
