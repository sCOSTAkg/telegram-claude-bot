import { CANVAS_W, CANVAS_H, TILE, SCALE } from './constants.js';

class Particle {
  constructor(x, y, vx, vy, life, color, size, type) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.life = life;
    this.maxLife = life;
    this.color = color;
    this.size = size;
    this.type = type;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (this.type === 'spark') {
      this.vy += 40 * dt;
    }
  }

  get alpha() {
    return Math.max(0, this.life / this.maxLife);
  }

  get isDead() {
    return this.life <= 0;
  }
}

export class ParticleSystem {
  constructor() {
    this.particles = [];
    this.ambientTimer = 0;
    this.searchlightTimer = 0;
    this.dustCount = 0;
    this._frame = 0;
  }

  // Yard dust motes
  spawnAmbientDust() {
    if (this.dustCount > 15) return;
    const x = Math.random() * CANVAS_W;
    const y = (10 + Math.random() * 4) * TILE * SCALE;
    const vx = (Math.random() - 0.5) * 6;
    const vy = (Math.random() - 0.5) * 3 - 1;
    this.particles.push(new Particle(x, y, vx, vy, 5 + Math.random() * 6, 'rgba(180,160,120,0.10)', 1.5, 'dust'));
    this.dustCount++;
  }

  // Thinking sparkles above character
  spawnThinkingSparkles(screenX, screenY) {
    for (let i = 0; i < 2; i++) {
      const x = screenX + (Math.random() - 0.5) * 20;
      const y = screenY - 8 - Math.random() * 12;
      const vx = (Math.random() - 0.5) * 20;
      const vy = -15 - Math.random() * 10;
      this.particles.push(new Particle(x, y, vx, vy, 0.6 + Math.random() * 0.4, '#f97316', 2, 'spark'));
    }
  }

  // Completion burst
  spawnCompletionBurst(screenX, screenY) {
    const colors = ['#f97316', '#fbbf24', '#10b981', '#06b6d4', '#ef4444'];
    for (let i = 0; i < 25; i++) {
      const angle = (i / 25) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 40 + Math.random() * 60;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const color = colors[Math.floor(Math.random() * colors.length)];
      this.particles.push(new Particle(screenX, screenY, vx, vy, 0.8 + Math.random() * 0.5, color, 2.5, 'spark'));
    }
  }

  // Error particles
  spawnErrorParticles(screenX, screenY) {
    for (let i = 0; i < 12; i++) {
      const vx = (Math.random() - 0.5) * 80;
      const vy = (Math.random() - 0.5) * 80;
      this.particles.push(new Particle(screenX, screenY, vx, vy, 0.5 + Math.random() * 0.3, '#ef4444', 3, 'square'));
    }
  }

  // Searchlight sparkles near guard tower
  spawnSearchlightSparkle() {
    const baseX = 15 * TILE * SCALE;
    const baseY = 15 * TILE * SCALE;
    const x = baseX + (Math.random() - 0.5) * 4 * TILE * SCALE;
    const y = baseY + (Math.random() - 0.5) * TILE * SCALE;
    this.particles.push(new Particle(x, y, 0, -5, 1 + Math.random(), 'rgba(251,191,36,0.15)', 2, 'circle'));
  }

  update(dt) {
    this._frame++;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update(dt);
      if (this.particles[i].isDead) {
        if (this.particles[i].type === 'dust') this.dustCount--;
        this.particles.splice(i, 1);
      }
    }

    this.ambientTimer += dt;
    if (this.ambientTimer > 1.0) {
      this.ambientTimer = 0;
      this.spawnAmbientDust();
    }

    this.searchlightTimer += dt;
    if (this.searchlightTimer > 0.5) {
      this.searchlightTimer = 0;
      if (Math.random() < 0.4) this.spawnSearchlightSparkle();
    }
  }

  draw(ctx) {
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = p.alpha;

      if (p.type === 'square') {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else if (p.type === 'spark') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.alpha, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  // Ambient lighting effects
  drawAmbientLighting(ctx) {
    // Guard tower searchlight sweeping the yard
    const towerX = 24 * TILE * SCALE;
    const angle = (this._frame / 300) * Math.PI * 2;
    const beamX = towerX + Math.cos(angle) * 6 * TILE * SCALE;
    const beamY = 12 * TILE * SCALE + Math.sin(angle * 0.7) * 2 * TILE * SCALE;

    const grad = ctx.createRadialGradient(beamX, beamY, 0, beamX, beamY, 3 * TILE * SCALE);
    grad.addColorStop(0, 'rgba(251,191,36,0.05)');
    grad.addColorStop(1, 'rgba(251,191,36,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(beamX - 4 * TILE * SCALE, beamY - 4 * TILE * SCALE, 8 * TILE * SCALE, 8 * TILE * SCALE);

    // Warden office warm light
    const offGrad = ctx.createRadialGradient(
      4 * TILE * SCALE, 1.5 * TILE * SCALE, 0,
      4 * TILE * SCALE, 1.5 * TILE * SCALE, 3 * TILE * SCALE
    );
    offGrad.addColorStop(0, 'rgba(249,115,22,0.04)');
    offGrad.addColorStop(1, 'rgba(249,115,22,0)');
    ctx.fillStyle = offGrad;
    ctx.fillRect(0, 0, 8 * TILE * SCALE, 3 * TILE * SCALE);
  }

}
