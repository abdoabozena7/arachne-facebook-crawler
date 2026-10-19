// World-space feet stay planted while the body advances. Two alternating groups
// of four legs lift and replant; this is locomotion, independent of crawl events.
export interface Point { x: number; y: number }
export interface LegPose { hip: Point; knee: Point; foot: Point; ground: Point; lift: number; stepping: boolean; group: number }
interface Leg {
  pair: number; side: number; group: number; ground: Point; from: Point; to: Point;
  progress: number; stepping: boolean;
}
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export function transformPoint(point: Point, center: Point, heading: number, scale = 1): Point {
  const c = Math.cos(heading), s = Math.sin(heading);
  return { x: center.x + (point.x * c - point.y * s) * scale, y: center.y + (point.x * s + point.y * c) * scale };
}
export class SpiderGait {
  private initialized = false;
  private nextGroup = 0;
  private legs: Leg[] = Array.from({ length: 8 }, (_, i) => ({ pair: i % 4, side: i < 4 ? 1 : -1, group: (i % 4 + (i < 4 ? 0 : 1)) % 2, ground: { x: 0, y: 0 }, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, progress: 1, stepping: false }));
  reset(): void { this.initialized = false; this.nextGroup = 0; this.legs.forEach(l => { l.stepping = false; l.progress = 1; }); }
  update(center: Point, heading: number, velocity: Point, dt: number, scale = 1): LegPose[] {
    const speed = Math.hypot(velocity.x, velocity.y);
    const duration = speed > 20 ? 0.32 : 0.48;
    const homes = this.legs.map(l => transformPoint({ x: [67, 32, -30, -72][l.pair], y: l.side * [62, 89, 92, 66][l.pair] }, center, heading, scale));
    if (!this.initialized) { this.legs.forEach((l, i) => l.ground = { ...homes[i] }); this.initialized = true; }
    if (dt > 0 && !this.legs.some(l => l.stepping)) {
      const needsStep = this.legs.some((l, i) => l.group === this.nextGroup && distance(l.ground, homes[i]) > 18 * scale);
      if (needsStep) this.legs.forEach((l, i) => {
        if (l.group !== this.nextGroup) return;
        l.from = { ...l.ground };
        l.to = { x: homes[i].x + velocity.x * duration * 0.6, y: homes[i].y + velocity.y * duration * 0.6 };
        l.progress = 0; l.stepping = true;
      });
    }
    let finished = false;
    for (const leg of this.legs) if (leg.stepping && dt > 0) {
      leg.progress = Math.min(1, leg.progress + dt / duration);
      const p = leg.progress, ease = p * p * (3 - 2 * p);
      leg.ground = { x: leg.from.x + (leg.to.x - leg.from.x) * ease, y: leg.from.y + (leg.to.y - leg.from.y) * ease };
      if (p === 1) { leg.stepping = false; finished = true; }
    }
    if (finished && !this.legs.some(l => l.stepping)) this.nextGroup = 1 - this.nextGroup;
    return this.legs.map(leg => {
      const hip = transformPoint({ x: [13, 6, -3, -12][leg.pair], y: leg.side * [7, 10, 10, 7][leg.pair] }, center, heading, scale);
      const lift = leg.stepping ? Math.sin(leg.progress * Math.PI) * 10 * scale : 0;
      const foot = { x: leg.ground.x, y: leg.ground.y - lift };
      const dx = foot.x - hip.x, dy = foot.y - hip.y, d = Math.max(0.1, Math.hypot(dx, dy));
      // Two-bone inverse kinematics keeps a visible elbow, including stretched legs.
      const stretch = Math.max(1, d / (108 * scale));
      const upper = 48 * scale * stretch, lower = 65 * scale * stretch;
      const along = (d * d + upper * upper - lower * lower) / (2 * d);
      const bend = Math.sqrt(Math.max(0, upper * upper - along * along)) * leg.side * (leg.pair < 2 ? -1 : 1);
      const knee = { x: hip.x + dx / d * along - dy / d * bend, y: hip.y + dy / d * along + dx / d * bend };
      return { hip, knee, foot, ground: { ...leg.ground }, lift, stepping: leg.stepping, group: leg.group };
    });
  }
}
