import { COLS, ROWS, isWalkable } from './constants.js';

// BFS pathfinding on tile grid
export function findPath(startX, startY, endX, endY) {
  if (startX === endX && startY === endY) return [];
  if (!isWalkable(endX, endY)) {
    // Find nearest walkable tile to target
    for (let r = 1; r < 5; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (isWalkable(endX + dx, endY + dy)) {
            endX += dx;
            endY += dy;
            break;
          }
        }
      }
    }
  }

  const queue = [[startX, startY]];
  const visited = new Set([`${startX},${startY}`]);
  const parent = new Map();

  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  while (queue.length > 0) {
    const [cx, cy] = queue.shift();
    if (cx === endX && cy === endY) {
      // Reconstruct path
      const path = [];
      let key = `${endX},${endY}`;
      while (parent.has(key)) {
        const [px, py] = key.split(',').map(Number);
        path.unshift({ x: px, y: py });
        key = parent.get(key);
      }
      return path;
    }

    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nkey = `${nx},${ny}`;
      if (!visited.has(nkey) && isWalkable(nx, ny)) {
        visited.add(nkey);
        parent.set(nkey, `${cx},${cy}`);
        queue.push([nx, ny]);
      }
    }
  }

  return []; // no path found
}
