/**
 * Deterministic PRNG (Mulberry32) so simulations are reproducible across
 * local preview, workerd authoritative rooms, and headless smoke tests.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty array");
    }
    return items[this.int(0, items.length - 1)]!;
  }
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function normalize(x: number, y: number): Vec2 {
  const len = Math.hypot(x, y);
  if (len <= 1e-6) return { x: 0, y: 0 };
  if (len <= 1) return { x, y };
  return { x: x / len, y: y / len };
}

export function circleOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
