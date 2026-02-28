export const TILE = 16;
export const SCALE = 3;
export const COLS = 20;
export const ROWS = 12;
export const CANVAS_W = COLS * TILE * SCALE;
export const CANVAS_H = ROWS * TILE * SCALE;

// Character states
export const STATE = {
  ENTERING: 'entering',
  WORKING: 'working',
  THINKING: 'thinking',
  WALKING: 'walking',
  IDLE: 'idle',
  COMPLETING: 'completing',
  ERROR: 'error',
};

// Dark theme colors (from sCORP landing)
export const COLORS = {
  bg: '#030014',
  floor: '#0a0520',
  floorAlt: '#0d0828',
  wall: '#1a1040',
  accent: '#8b5cf6',
  cyan: '#06b6d4',
  emerald: '#10b981',
  text: '#e4e4e7',
  textDim: '#71717a',
  error: '#ef4444',
  desk: '#2d1f5e',
  deskTop: '#3d2d7e',
  chair: '#4a3080',
  monitor: '#1e1548',
  monitorScreen: '#1a2744',
  monitorScreenOn: '#0f3460',
  plant: '#065f46',
  plantPot: '#78350f',
  door: '#44403c',
  doorFrame: '#78716c',
  server: '#1e293b',
  serverLight: '#22c55e',
};

// Role to HSL hue mapping for character colors
export const ROLE_HUES = {
  orchestrator: 30,   // orange
  coder: 260,         // purple
  researcher: 200,    // blue
  reviewer: 180,      // teal
  writer: 45,         // gold
  executor: 15,       // red-orange
  python_dev: 60,     // yellow-green
  web_dev: 210,       // sky blue
  data_analyst: 280,  // violet
  devops: 160,        // green-cyan
  security: 0,        // red
  technical_writer: 50, // amber
  seo: 190,           // cyan-blue
  social_media: 320,  // pink
  content_creator: 35, // warm orange
  translator: 140,    // green
  ux_ui_designer: 300, // magenta
};

// Hash string to hue for custom roles
export function hashToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

// Desk positions (tile coords) — 6 workstations
export const DESKS = [
  { x: 2, y: 1 },
  { x: 5, y: 1 },
  { x: 8, y: 1 },
  { x: 11, y: 1 },
  { x: 14, y: 1 },
  { x: 17, y: 1 },
];

// Chair positions (where characters sit) — below each desk
export const CHAIRS = DESKS.map(d => ({ x: d.x, y: d.y + 1 }));

// Meeting area
export const MEETING_TABLE = [
  { x: 7, y: 5 }, { x: 8, y: 5 },
];
export const MEETING_CHAIRS = [
  { x: 7, y: 4 }, { x: 8, y: 4 },
  { x: 7, y: 6 }, { x: 8, y: 6 },
];

// Door position
export const DOOR = { x: 1, y: 10 };

// Server rack
export const SERVERS = [
  { x: 17, y: 9 }, { x: 18, y: 9 },
  { x: 17, y: 10 }, { x: 18, y: 10 },
];

// Plant decoration
export const PLANTS = [
  { x: 1, y: 11 },
  { x: 10, y: 8 },
];

// Walkable tiles (simple check)
const BLOCKED = new Set();
// Block desks, servers
[...DESKS, ...MEETING_TABLE, ...SERVERS].forEach(p => BLOCKED.add(`${p.x},${p.y}`));

export function isWalkable(x, y) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return false;
  return !BLOCKED.has(`${x},${y}`);
}
