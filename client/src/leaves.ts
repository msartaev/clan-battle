import { Color4, DynamicTexture, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";
import type { TreeInfo } from "./world";

/**
 * Падающие листья (идея Даниэля): с ближайших лиственных деревьев время от времени слетают
 * осенние листочки и, кружась, опускаются на землю. Один ParticleSystem на всю карту.
 */
export class FallingLeaves {
  private ps: ParticleSystem;
  private near: TreeInfo[] = [];
  private refreshIn = 0;

  constructor(scene: Scene) {
    const tex = new DynamicTexture("leafTex", { width: 64, height: 64 }, scene, false);
    const c = tex.getContext() as CanvasRenderingContext2D;
    c.clearRect(0, 0, 64, 64);
    c.fillStyle = "#fff";
    c.beginPath();
    c.moveTo(32, 4);
    c.quadraticCurveTo(60, 30, 32, 60);
    c.quadraticCurveTo(4, 30, 32, 4);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(32, 8);
    c.lineTo(32, 58);
    c.stroke();
    tex.hasAlpha = true;
    tex.update();

    const ps = new ParticleSystem("leaves", 220, scene);
    ps.particleTexture = tex;
    ps.emitter = Vector3.Zero();
    ps.startPositionFunction = (_m, pos) => {
      const t = this.near[Math.floor(Math.random() * this.near.length)];
      if (!t) {
        pos.set(0, -100, 0);
        return;
      }
      const a = Math.random() * Math.PI * 2;
      const r = 0.5 + Math.random() * 2.2;
      pos.set(t.pos.x + Math.cos(a) * r, t.pos.y + 3 + Math.random() * 2.5, t.pos.z + Math.sin(a) * r);
    };
    ps.direction1 = new Vector3(-0.6, -0.2, -0.6);
    ps.direction2 = new Vector3(0.6, 0, 0.6);
    ps.minEmitPower = 0.3;
    ps.maxEmitPower = 0.8;
    ps.gravity = new Vector3(0.15, -0.35, 0.05);
    ps.minLifeTime = 5;
    ps.maxLifeTime = 8;
    ps.minSize = 0.1;
    ps.maxSize = 0.18;
    ps.minAngularSpeed = -3;
    ps.maxAngularSpeed = 3;
    ps.color1 = new Color4(0.95, 0.62, 0.15, 1);
    ps.color2 = new Color4(0.75, 0.3, 0.1, 1);
    ps.colorDead = new Color4(0.6, 0.55, 0.2, 0.9);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = 0;
    ps.start();
    this.ps = ps;
  }

  update(dt: number, cam: Vector3, trees: TreeInfo[]): void {
    this.refreshIn -= dt;
    if (this.refreshIn > 0) return;
    this.refreshIn = 1;
    this.near = trees.filter((t) => !t.pine && t.fallT === 0 && (t.pos.x - cam.x) ** 2 + (t.pos.z - cam.z) ** 2 < 30 * 30);
    // Каждое дерево рядом роняет примерно лист в две секунды
    this.ps.emitRate = Math.min(14, this.near.length * 0.5);
  }

  dispose(): void {
    this.ps.dispose();
  }
}
