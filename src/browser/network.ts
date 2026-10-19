import type { Rect } from '../types.js';
import { SpiderGait, transformPoint } from './gait.js';
const colors = ['#fc42c8', '#a17bff', '#4be9ed', '#5384ff', '#80f4c5'];
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string }
export class SpiderNetwork {
  private ctx: CanvasRenderingContext2D;
  private width = 0; private height = 0; private frame = 0; private last = 0; private clock = 0;
  private position = { x: 0, y: 0, vx: 0, vy: 0 };
  private nodes = Array.from({ length: 30 }, () => ({ x: 0, y: 0 }));
  private gait = new SpiderGait();
  private heading = -Math.PI / 2;
  private particles: Particle[] = [];
  private pulse = 0;
  private failure = false;
  private resizeObserver: ResizeObserver;
  paused = false;
  speed = 1;
  constructor(readonly canvas: HTMLCanvasElement, readonly target: () => Rect | null, readonly idleBias = 0.48, readonly related: () => Rect[] = () => []) {
    this.ctx = canvas.getContext('2d')!;
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(canvas);
    this.resize(); this.frame = requestAnimationFrame(t => this.draw(t));
  }
  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (this.width && this.height) { this.position.x *= r.width / this.width; this.position.y *= r.height / this.height; }
    this.width = r.width; this.height = r.height;
    this.gait.reset();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.position.x) { this.position.x = r.width / 2; this.position.y = r.height / 2; }
  }
  signal(success = false, failure = false): void {
    this.pulse = 1; this.failure = failure;
    if (success) for (let i = 0; i < 24; i++) {
      const a = i * Math.PI / 12;
      this.particles.push({ x: this.position.x, y: this.position.y, vx: Math.cos(a) * (30 + Math.random() * 60), vy: Math.sin(a) * (30 + Math.random() * 60), life: 1, color: colors[i % colors.length] });
    }
  }
  private draw(now: number): void {
    const dt = this.paused ? 0 : Math.min((now - (this.last || now)) / 1000, 0.04) * this.speed;
    this.last = now; this.clock += dt;
    const t = this.clock, ctx = this.ctx, target = this.target();
    const tx = target ? Math.max(45, Math.min(this.width - 45, target.x + Math.min(target.width * 0.32, 180))) : this.width * this.idleBias + Math.sin(t * 0.6) * 40;
    const ty = target ? Math.max(70, Math.min(this.height - 50, target.y + Math.min(target.height * 0.42, 140))) : this.height * 0.5 + Math.cos(t * 0.45) * 25;
    this.position.vx += (tx - this.position.x) * 22 * dt;
    this.position.vy += (ty - this.position.y) * 22 * dt;
    const friction = Math.exp(-8 * dt); this.position.vx *= friction; this.position.vy *= friction;
    const velocity = Math.hypot(this.position.vx, this.position.vy);
    if (velocity > 190) { this.position.vx *= 190 / velocity; this.position.vy *= 190 / velocity; }
    this.position.x += this.position.vx * dt; this.position.y += this.position.vy * dt;
    const moving = Math.hypot(this.position.vx, this.position.vy);
    if (moving > 6) {
      const desired = Math.atan2(this.position.vy, this.position.vx);
      const turn = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading));
      this.heading += turn * (1 - Math.exp(-4 * dt));
    }
    this.pulse = Math.max(0, this.pulse - dt * 0.7);
    ctx.clearRect(0, 0, this.width, this.height);
    const scale = Math.min(1, Math.max(0.6, Math.min(this.width / 480, this.height / 380)));
    const sway = Math.sin(t * 8) * Math.min(moving / 35, 1) * 1.4;
    const center = { x: this.position.x - Math.sin(this.heading) * sway, y: this.position.y + Math.cos(this.heading) * sway };
    const body = [{ x: -25, y: 0 }, { x: -12, y: -12 }, { x: 12, y: -8 }, { x: 21, y: 0 }, { x: 12, y: 8 }, { x: -12, y: 12 }];
    body.forEach((p, i) => this.nodes[i] = transformPoint({ x: p.x, y: p.y * (1 + Math.sin(t * 2) * 0.05) }, center, this.heading, scale));
    const legs = this.gait.update(center, this.heading, { x: this.position.vx, y: this.position.vy }, dt, scale);
    legs.forEach((leg, i) => { this.nodes[6 + i * 3] = leg.hip; this.nodes[7 + i * 3] = leg.knee; this.nodes[8 + i * 3] = leg.foot; });
    if (target) {
      const x = Math.max(2, target.x), y = Math.max(2, target.y);
      ctx.strokeStyle = this.failure ? '#ff8b79' : '#ad7aff'; ctx.lineWidth = 1; ctx.globalAlpha = 0.35 + this.pulse * 0.3;
      const w = Math.min(target.width, this.width - x - 2), h = Math.min(target.height, this.height - y - 2);
      if (w > 0 && h > 0) { ctx.setLineDash([8, 5]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); }
    }
    ctx.globalAlpha = 1;
    this.nodes.forEach((a, i) => {
      const legIndex = Math.floor((i - 6) / 3);
      const connections = i < 6 ? [(i + 1) % 6, (i + 3) % 6] : (i - 6) % 3 === 0 ? [legIndex < 4 ? 4 : 2, i + 1] : (i - 6) % 3 === 1 ? [i + 1] : [];
      connections.forEach(index => {
        const b = this.nodes[index];
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        const stepping = i >= 6 && legs[legIndex].stepping;
        ctx.strokeStyle = colors[(i < 6 ? i : legIndex) % colors.length]; ctx.globalAlpha = (stepping ? 0.85 : 0.56) + this.pulse * 0.12; ctx.lineWidth = i < 6 ? 0.8 : 1.25; ctx.stroke();
      });
    });
    // Ground contacts make foot planting and lifted steps legible on a text page.
    legs.forEach((leg, i) => {
      ctx.strokeStyle = colors[i % colors.length]; ctx.globalAlpha = leg.stepping ? 0.15 : 0.45;
      ctx.beginPath(); ctx.arc(leg.ground.x, leg.ground.y, leg.stepping ? 2 : 3, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    this.related().slice(0, 10).forEach((r, i) => {
      const x = r.x + Math.min(r.width * 0.5, 180), y = r.y + r.height * 0.5;
      if (x < 0 || x > this.width || y < 0 || y > this.height) return;
      const n = this.nodes[8 + (i % 8) * 3];
      ctx.strokeStyle = colors[i % colors.length]; ctx.globalAlpha = 0.4; ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(x, y); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 3 + this.pulse * 2, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    this.nodes.forEach((n, i) => {
      const c = this.failure && this.pulse > 0 ? '#ff8b79' : colors[i % colors.length];
      ctx.shadowColor = c; ctx.shadowBlur = 10; ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(n.x, n.y, i < 6 ? 2.2 : 1.5 + this.pulse * 0.4, 0, Math.PI * 2); ctx.fill();
    });
    ctx.shadowBlur = 0;
    if (this.pulse > 0) {
      ctx.strokeStyle = this.failure ? '#ff8b79' : '#80f4c5'; ctx.globalAlpha = this.pulse * 0.45;
      ctx.beginPath(); ctx.arc(this.position.x, this.position.y, (1 - this.pulse) * 110 + 15, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter(p => p.life > 0);
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; ctx.globalAlpha = Math.max(p.life, 0); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 2, 2); }
    ctx.globalAlpha = 1;
    this.frame = requestAnimationFrame(t => this.draw(t));
  }
  destroy(): void { cancelAnimationFrame(this.frame); this.resizeObserver.disconnect(); this.ctx.clearRect(0, 0, this.width, this.height); }
}
