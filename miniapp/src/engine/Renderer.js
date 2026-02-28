import { CANVAS_W, CANVAS_H, COLORS, TILE, SCALE, COLS } from './constants.js';
import { drawOffice } from './Office.js';
import { drawCharacter } from './Sprites.js';
import { drawBubble } from './Bubbles.js';

export class Renderer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  render(characters, globalState) {
    const ctx = this.ctx;

    // Clear
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Determine which desks are active
    const activeDesks = [];
    for (const ch of characters) {
      if (ch.seatIdx >= 0 && ch.seatIdx < 6 && (ch.state === 'working' || ch.state === 'thinking')) {
        activeDesks.push(ch.seatIdx);
      }
    }

    // Draw office (floor, furniture)
    drawOffice(ctx, activeDesks);

    // Z-sort characters by Y position
    const sorted = [...characters].sort((a, b) => a.y - b.y);

    // Draw characters
    for (const ch of sorted) {
      if (ch.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = ch.opacity;
      drawCharacter(ctx, ch.screenX, ch.screenY, ch.hue, ch.frame, ch.state);
      drawBubble(ctx, ch);
      ctx.restore();
    }

    // UI Overlay — top bar
    this._drawOverlay(ctx, globalState, characters.length);
  }

  _drawOverlay(ctx, globalState, charCount) {
    if (!globalState) return;

    const barH = 24;
    ctx.fillStyle = 'rgba(3,0,20,0.8)';
    ctx.fillRect(0, 0, CANVAS_W, barH);

    ctx.save();
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = COLORS.text;
    ctx.textBaseline = 'middle';

    const items = [];
    items.push(`🤖 ${globalState.activeClaudeCount || 0}/${globalState.maxClaude || 3} AI`);
    if (globalState.queueSize > 0) items.push(`📬 ${globalState.queueSize} в очереди`);
    if (charCount > 0) items.push(`👥 ${charCount} агентов`);

    let tx = 10;
    for (const item of items) {
      ctx.fillText(item, tx, barH / 2);
      tx += ctx.measureText(item).width + 16;
    }

    ctx.restore();
  }
}
