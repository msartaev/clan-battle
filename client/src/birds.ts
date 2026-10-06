import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";

/**
 * Птицы (GDD: «летают и поют, не сражаются»): две стайки кружат над картой,
 * машут крыльями и иногда планируют. Чисто для живости мира — в бою не участвуют.
 */

interface Bird {
  root: TransformNode;
  wingL: Mesh;
  wingR: Mesh;
  /** Своя орбита: центр стаи + смещение, фаза и скорость */
  offset: Vector3;
  phase: number;
  flap: number;
}

interface Flock {
  center: Vector3;
  radius: number;
  height: number;
  speed: number;
  t: number;
  birds: Bird[];
}

export class Birds {
  private flocks: Flock[] = [];

  constructor(scene: Scene, count: number) {
    const body = new StandardMaterial("birdBody", scene);
    body.diffuseColor = new Color3(0.18, 0.17, 0.16);
    body.specularColor = new Color3(0, 0, 0);
    const wing = new StandardMaterial("birdWing", scene);
    wing.diffuseColor = new Color3(0.25, 0.24, 0.22);
    wing.specularColor = new Color3(0, 0, 0);
    wing.backFaceCulling = false;

    const specs = [
      { center: new Vector3(-20, 0, 25), radius: 22, height: 24, speed: 0.18 },
      { center: new Vector3(25, 0, -20), radius: 16, height: 19, speed: -0.24 },
    ];
    let made = 0;
    specs.forEach((sp, fi) => {
      const flock: Flock = { ...sp, t: fi * 2, birds: [] };
      const n = Math.ceil(count / specs.length);
      for (let i = 0; i < n && made < count; i++, made++) {
        const root = new TransformNode(`bird${fi}_${i}`, scene);
        // Крупнее настоящих — иначе с земли на высоте 20 м их не разглядеть
        root.scaling.setAll(2.6);
        const b = MeshBuilder.CreateSphere(`birdB${fi}_${i}`, { diameterX: 0.12, diameterY: 0.1, diameterZ: 0.32, segments: 6 }, scene);
        b.material = body;
        b.parent = root;
        b.isPickable = false;
        const mk = (side: number) => {
          // Крыло — плоский треугольник, шарнир у тела
          const w = MeshBuilder.CreateDisc(`birdW${fi}_${i}_${side}`, { radius: 0.32, tessellation: 3 }, scene);
          w.rotation.x = Math.PI / 2;
          w.scaling.set(1, 0.45, 1);
          w.bakeCurrentTransformIntoVertices();
          w.position.x = side * 0.05;
          const pivot = new TransformNode(`birdWP${fi}_${i}_${side}`, scene);
          pivot.parent = root;
          w.parent = pivot;
          w.position.set(side * 0.3, 0, 0);
          w.material = wing;
          w.isPickable = false;
          return w;
        };
        const wingL = mk(-1);
        const wingR = mk(1);
        flock.birds.push({
          root,
          wingL,
          wingR,
          offset: new Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6),
          phase: Math.random() * Math.PI * 2,
          flap: 9 + Math.random() * 3,
        });
      }
      this.flocks.push(flock);
    });
  }

  update(dt: number, now: number): void {
    for (const f of this.flocks) {
      f.t += dt * f.speed;
      for (const b of f.birds) {
        const a = f.t + b.phase * 0.05;
        const wob = Math.sin(now * 0.7 + b.phase) * 1.5;
        const x = f.center.x + Math.cos(a) * (f.radius + b.offset.x) ;
        const z = f.center.z + Math.sin(a) * (f.radius + b.offset.z);
        const y = f.height + b.offset.y + wob;
        b.root.position.set(x, y, z);
        // Летит по касательной к кругу
        const dir = Math.sign(f.speed);
        b.root.rotation.y = Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir);
        // Взмахи; время от времени планирует с раскрытыми крыльями
        const glide = Math.sin(now * 0.4 + b.phase) > 0.6;
        const ang = glide ? 0.12 : Math.sin(now * b.flap + b.phase) * 0.7;
        (b.wingL.parent as TransformNode).rotation.z = ang;
        (b.wingR.parent as TransformNode).rotation.z = -ang;
      }
    }
  }
}
