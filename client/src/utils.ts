import { Vector3 } from "@babylonjs/core";

/** Детерминированный генератор случайных чисел (mulberry32), чтобы карта была одинаковой */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Разница углов в диапазоне [-PI, PI] */
export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Направление взгляда по yaw/pitch (pitch > 0 — вниз, как у камеры Babylon) */
export function dirFromYawPitch(yaw: number, pitch: number, out = new Vector3()): Vector3 {
  const cp = Math.cos(pitch);
  out.set(Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp);
  return out;
}

/** Случайно отклоняет направление в конусе с углом spread (радианы) */
export function applySpread(dir: Vector3, spread: number, rnd: () => number = Math.random): Vector3 {
  if (spread <= 0) return dir.clone();
  const up = Math.abs(dir.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = Vector3.Cross(up, dir).normalize();
  const realUp = Vector3.Cross(dir, right).normalize();
  const r = Math.sqrt(rnd()) * spread;
  const a = rnd() * Math.PI * 2;
  return dir
    .add(right.scale(Math.cos(a) * r))
    .add(realUp.scale(Math.sin(a) * r))
    .normalize();
}

/**
 * Ближайшее сближение луча (origin, dir единичный, длина maxLen)
 * с вертикальным отрезком (x, y0..y1, z) — «капсулой» персонажа.
 * Возвращает расстояние вдоль луча и расстояние между линиями.
 */
export function rayVsVerticalSegment(
  origin: Vector3,
  dir: Vector3,
  maxLen: number,
  x: number,
  y0: number,
  y1: number,
  z: number,
): { t: number; dist: number } {
  // Отрезок 1: P(s) = origin + dir*s, s ∈ [0, maxLen]; отрезок 2: Q(u) = (x, y0 + u, z), u ∈ [0, h]
  const h = y1 - y0;
  const rx = origin.x - x;
  const ry = origin.y - y0;
  const rz = origin.z - z;
  const a = 1; // dir·dir
  const e = 1; // up·up
  const b = dir.y; // dir·up
  const c = dir.x * rx + dir.y * ry + dir.z * rz; // dir·r
  const f = ry; // up·r
  const denom = a * e - b * b;
  let s = denom > 1e-6 ? clamp((b * f - c * e) / denom, 0, maxLen) : 0;
  let u = clamp(b * s + f, 0, h);
  s = clamp(b * u - c, 0, maxLen);
  u = clamp(b * s + f, 0, h);
  const px = origin.x + dir.x * s - x;
  const py = origin.y + dir.y * s - (y0 + u);
  const pz = origin.z + dir.z * s - z;
  return { t: s, dist: Math.sqrt(px * px + py * py + pz * pz) };
}

export function isTouchDevice(): boolean {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}
