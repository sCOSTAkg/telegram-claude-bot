import { TILE, SCALE } from './constants.js';

const S = TILE * SCALE; // sprite size in screen pixels

// Draw a pixel-art character using fillRect
// hue: HSL hue for body color
// frame: animation frame (0-3)
// state: character state string
export function drawCharacter(ctx, screenX, screenY, hue, frame, state, direction) {
  const s = S;
  const px = s / 8; // pixel unit = 1/8 of sprite

  ctx.save();
  ctx.translate(screenX, screenY);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(px, s - px, 6 * px, px);

  const bodyColor = `hsl(${hue}, 65%, 45%)`;
  const bodyLight = `hsl(${hue}, 65%, 55%)`;
  const skinColor = `hsl(30, 60%, 70%)`;
  const hairColor = `hsl(${(hue + 180) % 360}, 40%, 30%)`;
  const shoeColor = `hsl(${hue}, 30%, 25%)`;

  if (state === 'working' || state === 'thinking') {
    // Sitting pose
    // Legs (bent)
    ctx.fillStyle = bodyColor;
    ctx.fillRect(2 * px, 6 * px, 2 * px, px);
    ctx.fillRect(4 * px, 6 * px, 2 * px, px);

    // Shoes
    ctx.fillStyle = shoeColor;
    ctx.fillRect(px, 7 * px, 2 * px, px);
    ctx.fillRect(5 * px, 7 * px, 2 * px, px);

    // Body
    ctx.fillStyle = bodyColor;
    ctx.fillRect(px, 3 * px, 6 * px, 3 * px);
    ctx.fillStyle = bodyLight;
    ctx.fillRect(2 * px, 3 * px, 4 * px, px);

    // Arms
    ctx.fillStyle = bodyColor;
    if (state === 'working') {
      // Typing animation
      const armOff = frame % 2 === 0 ? 0 : -px;
      ctx.fillRect(0, 4 * px + armOff, px, 2 * px);
      ctx.fillRect(7 * px, 4 * px - armOff, px, 2 * px);
    } else {
      // Thinking: hand on chin
      ctx.fillRect(0, 4 * px, px, 2 * px);
      ctx.fillStyle = skinColor;
      ctx.fillRect(6 * px, 2 * px, 2 * px, px); // hand near face
    }

    // Head
    ctx.fillStyle = skinColor;
    ctx.fillRect(px, px, 6 * px, 2 * px);

    // Hair
    ctx.fillStyle = hairColor;
    ctx.fillRect(px, 0, 6 * px, px);
    ctx.fillRect(px, px, px, px);

    // Eyes
    ctx.fillStyle = '#111';
    ctx.fillRect(3 * px, 2 * px, px, px);
    ctx.fillRect(5 * px, 2 * px, px, px);
  } else {
    // Standing / walking pose
    const walkCycle = Math.floor(frame) % 4;
    const isWalking = state === 'entering' || state === 'walking' || state === 'completing';

    // Legs
    ctx.fillStyle = bodyColor;
    if (isWalking) {
      const legOff = walkCycle < 2 ? px : -px;
      ctx.fillRect(2 * px, 6 * px + legOff, 2 * px, px);
      ctx.fillRect(4 * px, 6 * px - legOff, 2 * px, px);
    } else {
      ctx.fillRect(2 * px, 6 * px, 2 * px, px);
      ctx.fillRect(4 * px, 6 * px, 2 * px, px);
    }

    // Shoes
    ctx.fillStyle = shoeColor;
    if (isWalking) {
      const legOff = walkCycle < 2 ? px : -px;
      ctx.fillRect(2 * px, 7 * px + legOff, 2 * px, px);
      ctx.fillRect(4 * px, 7 * px - legOff, 2 * px, px);
    } else {
      ctx.fillRect(2 * px, 7 * px, 2 * px, px);
      ctx.fillRect(4 * px, 7 * px, 2 * px, px);
    }

    // Body
    ctx.fillStyle = bodyColor;
    ctx.fillRect(px, 3 * px, 6 * px, 3 * px);
    ctx.fillStyle = bodyLight;
    ctx.fillRect(2 * px, 3 * px, 4 * px, px);

    // Arms
    ctx.fillStyle = bodyColor;
    if (isWalking) {
      const armOff = walkCycle < 2 ? -px : px;
      ctx.fillRect(0, 3 * px + armOff, px, 3 * px);
      ctx.fillRect(7 * px, 3 * px - armOff, px, 3 * px);
    } else {
      ctx.fillRect(0, 3 * px, px, 3 * px);
      ctx.fillRect(7 * px, 3 * px, px, 3 * px);
    }

    // Head
    ctx.fillStyle = skinColor;
    ctx.fillRect(px, px, 6 * px, 2 * px);

    // Hair
    ctx.fillStyle = hairColor;
    ctx.fillRect(px, 0, 6 * px, px);
    ctx.fillRect(px, px, px, px);

    // Eyes
    ctx.fillStyle = '#111';
    ctx.fillRect(3 * px, 2 * px, px, px);
    ctx.fillRect(5 * px, 2 * px, px, px);
  }

  // Error state flash
  if (state === 'error') {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
    ctx.fillRect(0, 0, s, s);
  }

  ctx.restore();
}

// Draw a monitor on a desk
export function drawMonitor(ctx, x, y, isActive) {
  const px = SCALE;
  // Stand
  ctx.fillStyle = '#374151';
  ctx.fillRect(x + 5 * px, y + 10 * px, 6 * px, 2 * px);
  ctx.fillRect(x + 6 * px, y + 8 * px, 4 * px, 2 * px);
  // Screen frame
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x + px, y, 14 * px, 8 * px);
  // Screen
  ctx.fillStyle = isActive ? '#0f3460' : '#111827';
  ctx.fillRect(x + 2 * px, y + px, 12 * px, 6 * px);
  if (isActive) {
    // Screen glow lines
    ctx.fillStyle = 'rgba(59,130,246,0.3)';
    ctx.fillRect(x + 3 * px, y + 2 * px, 8 * px, px);
    ctx.fillRect(x + 3 * px, y + 4 * px, 6 * px, px);
    ctx.fillRect(x + 3 * px, y + 6 * px, 10 * px, px);
  }
}
