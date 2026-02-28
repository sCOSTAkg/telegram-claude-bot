import { TILE, SCALE, COLS, ROWS, COLORS, DESKS, CHAIRS, MEETING_TABLE, MEETING_CHAIRS, DOOR, SERVERS, PLANTS } from './constants.js';
import { drawMonitor } from './Sprites.js';

const S = TILE * SCALE;

export function drawOffice(ctx, activeDesks) {
  const activeDeskSet = new Set(activeDesks || []);

  // Floor
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.floor : COLORS.floorAlt;
      ctx.fillRect(x * S, y * S, S, S);
    }
  }

  // Wall (top row background)
  ctx.fillStyle = COLORS.wall;
  ctx.fillRect(0, 0, COLS * S, S * 0.6);

  // Desks
  for (let i = 0; i < DESKS.length; i++) {
    const d = DESKS[i];
    const dx = d.x * S;
    const dy = d.y * S;

    // Desk surface
    ctx.fillStyle = COLORS.desk;
    ctx.fillRect(dx, dy + S * 0.3, S, S * 0.7);
    ctx.fillStyle = COLORS.deskTop;
    ctx.fillRect(dx, dy + S * 0.3, S, S * 0.15);

    // Monitor
    drawMonitor(ctx, dx + 4, dy - S * 0.2, activeDeskSet.has(i));
  }

  // Chairs
  for (const c of CHAIRS) {
    drawChair(ctx, c.x * S, c.y * S);
  }

  // Meeting table
  for (const mt of MEETING_TABLE) {
    ctx.fillStyle = COLORS.desk;
    ctx.fillRect(mt.x * S, mt.y * S + 4, S, S - 8);
    ctx.fillStyle = COLORS.deskTop;
    ctx.fillRect(mt.x * S, mt.y * S + 4, S, 4);
  }

  // Meeting chairs
  for (const mc of MEETING_CHAIRS) {
    drawChair(ctx, mc.x * S, mc.y * S);
  }

  // Door
  const doorX = DOOR.x * S;
  const doorY = DOOR.y * S;
  ctx.fillStyle = COLORS.doorFrame;
  ctx.fillRect(doorX - 2, doorY - 4, S + 4, S + 4);
  ctx.fillStyle = COLORS.door;
  ctx.fillRect(doorX, doorY, S, S);
  // Door handle
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(doorX + S - 8, doorY + S / 2, 4, 4);

  // Server racks
  for (const srv of SERVERS) {
    const sx = srv.x * S;
    const sy = srv.y * S;
    ctx.fillStyle = COLORS.server;
    ctx.fillRect(sx + 2, sy + 2, S - 4, S - 4);
    // Rack lines
    ctx.fillStyle = '#334155';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(sx + 6, sy + 8 + i * 12, S - 12, 2);
    }
    // Blinking lights
    const blink = Date.now() % 1000 > 500;
    ctx.fillStyle = blink ? COLORS.serverLight : '#064e3b';
    ctx.fillRect(sx + S - 10, sy + 8, 4, 4);
    ctx.fillStyle = !blink ? '#3b82f6' : '#1e3a5f';
    ctx.fillRect(sx + S - 10, sy + 20, 4, 4);
  }

  // Plants
  for (const p of PLANTS) {
    const px = p.x * S;
    const py = p.y * S;
    // Pot
    ctx.fillStyle = COLORS.plantPot;
    ctx.fillRect(px + S * 0.2, py + S * 0.6, S * 0.6, S * 0.4);
    // Leaves
    ctx.fillStyle = COLORS.plant;
    ctx.fillRect(px + S * 0.1, py + S * 0.2, S * 0.3, S * 0.4);
    ctx.fillRect(px + S * 0.4, py + S * 0.1, S * 0.3, S * 0.5);
    ctx.fillRect(px + S * 0.25, py, S * 0.3, S * 0.3);
  }
}

function drawChair(ctx, x, y) {
  const px = SCALE;
  ctx.fillStyle = COLORS.chair;
  // Seat
  ctx.fillRect(x + 4 * px, y + 6 * px, 8 * px, 4 * px);
  // Backrest
  ctx.fillRect(x + 4 * px, y + 2 * px, 8 * px, 4 * px);
  ctx.fillStyle = 'rgba(139,92,246,0.15)';
  ctx.fillRect(x + 5 * px, y + 3 * px, 6 * px, 2 * px);
  // Legs
  ctx.fillStyle = '#374151';
  ctx.fillRect(x + 6 * px, y + 10 * px, 4 * px, 6 * px);
}
