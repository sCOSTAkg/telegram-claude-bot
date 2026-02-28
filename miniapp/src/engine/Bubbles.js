import { TILE, SCALE, STATE } from './constants.js';

const S = TILE * SCALE;

export function drawBubble(ctx, character) {
  const { state, icon, label, actionName, actionDetail, thought, step, maxSteps, phase } = character;
  if (state === STATE.ENTERING || state === STATE.COMPLETING) return;

  const x = character.screenX;
  const y = character.screenY;

  // Name label below character
  ctx.save();
  ctx.font = `bold ${10}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  const nameText = `${icon} ${(label || '').slice(0, 12)}`;
  ctx.fillText(nameText, x + S / 2, y + S + 12);
  ctx.restore();

  // Status bubble above character
  let bubbleText = '';
  let bubbleIcon = '';

  if (state === STATE.ERROR) {
    bubbleIcon = '❌';
    bubbleText = 'Ошибка';
  } else if (state === STATE.WORKING && actionName) {
    bubbleIcon = '⚡';
    bubbleText = actionDetail ? `${actionName}: ${actionDetail}`.slice(0, 25) : actionName.slice(0, 25);
  } else if (state === STATE.THINKING && thought) {
    bubbleIcon = '💭';
    bubbleText = thought.slice(0, 25);
  } else if (phase) {
    bubbleIcon = '🔄';
    bubbleText = phase.slice(0, 25);
  } else if (state === STATE.IDLE) {
    return; // no bubble for idle
  } else {
    return;
  }

  // Progress bar if available
  let progressText = '';
  if (step > 0 && maxSteps > 0) {
    const filled = Math.min(step, maxSteps);
    progressText = '▓'.repeat(filled) + '░'.repeat(Math.max(0, maxSteps - filled)) + ` ${step}/${maxSteps}`;
  }

  ctx.save();
  const bx = x + S / 2;
  const by = y - 8;

  // Measure text
  ctx.font = '9px monospace';
  const line1 = `${bubbleIcon} ${bubbleText}`;
  const w1 = ctx.measureText(line1).width;
  const w2 = progressText ? ctx.measureText(progressText).width : 0;
  const bw = Math.max(w1, w2) + 12;
  const bh = progressText ? 28 : 18;

  // Bubble background
  ctx.fillStyle = 'rgba(3,0,20,0.85)';
  const rx = bx - bw / 2;
  const ry = by - bh;
  roundRect(ctx, rx, ry, bw, bh, 4);
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(139,92,246,0.4)';
  ctx.lineWidth = 1;
  roundRect(ctx, rx, ry, bw, bh, 4);
  ctx.stroke();

  // Pointer triangle
  ctx.fillStyle = 'rgba(3,0,20,0.85)';
  ctx.beginPath();
  ctx.moveTo(bx - 4, by);
  ctx.lineTo(bx, by + 4);
  ctx.lineTo(bx + 4, by);
  ctx.closePath();
  ctx.fill();

  // Text
  ctx.fillStyle = '#e4e4e7';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(line1, bx, ry + 13);

  if (progressText) {
    ctx.fillStyle = '#8b5cf6';
    ctx.fillText(progressText, bx, ry + 24);
  }

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
