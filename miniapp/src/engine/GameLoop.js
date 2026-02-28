export class GameLoop {
  constructor(updateFn, renderFn) {
    this.update = updateFn;
    this.render = renderFn;
    this.running = false;
    this.lastTime = 0;
    this.rafId = null;
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this._tick(this.lastTime);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  _tick = (now) => {
    if (!this.running) return;
    const dt = Math.min((now - this.lastTime) / 1000, 0.1); // cap at 100ms
    this.lastTime = now;
    this.update(dt);
    this.render();
    this.rafId = requestAnimationFrame(this._tick);
  };
}
