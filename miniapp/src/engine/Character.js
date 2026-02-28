import { STATE, TILE, SCALE, DOOR, CHAIRS, MEETING_CHAIRS, ROLE_HUES, hashToHue } from './constants.js';
import { findPath } from './Pathfinder.js';

let nextSeatIdx = 0;

export class Character {
  constructor(id, role, icon, label) {
    this.id = id;
    this.role = role;
    this.icon = icon || '🤖';
    this.label = label || role;
    this.hue = ROLE_HUES[role] ?? hashToHue(role);

    // Position in tile coords (fractional for smooth movement)
    this.x = DOOR.x;
    this.y = DOOR.y;
    this.targetX = DOOR.x;
    this.targetY = DOOR.y;

    // Assigned seat
    this.seatIdx = -1;
    this.seat = null;

    this.state = STATE.ENTERING;
    this.path = [];
    this.pathIdx = 0;
    this.frame = 0;
    this.frameTimer = 0;
    this.speed = 3; // tiles per second

    // Status info from SSE
    this.actionName = null;
    this.actionDetail = null;
    this.thought = null;
    this.step = 0;
    this.maxSteps = 0;
    this.phase = '';
    this.startTime = Date.now();

    this.opacity = 0; // fade in
    this.removing = false;
    this.idleTimer = 0;
    this.idleTarget = null;
  }

  assignSeat(isMeeting) {
    const seats = isMeeting ? MEETING_CHAIRS : CHAIRS;
    this.seatIdx = nextSeatIdx % seats.length;
    nextSeatIdx++;
    this.seat = seats[this.seatIdx];
    this.path = findPath(Math.round(this.x), Math.round(this.y), this.seat.x, this.seat.y);
    this.pathIdx = 0;
    this.state = STATE.ENTERING;
  }

  updateFromData(data) {
    if (data.actionName !== undefined) this.actionName = data.actionName;
    if (data.actionDetail !== undefined) this.actionDetail = data.actionDetail;
    if (data.thought !== undefined) this.thought = data.thought;
    if (data.step !== undefined) this.step = data.step;
    if (data.maxSteps !== undefined) this.maxSteps = data.maxSteps;
    if (data.phase !== undefined) this.phase = data.phase;
    if (data.startTime !== undefined) this.startTime = data.startTime;

    // Determine target state from data
    if (data.error) {
      this.state = STATE.ERROR;
    } else if (data.status === 'done' || data.status === 'completed') {
      if (this.state !== STATE.COMPLETING) {
        this.state = STATE.COMPLETING;
        this.removing = true;
        this.path = findPath(Math.round(this.x), Math.round(this.y), DOOR.x, DOOR.y);
        this.pathIdx = 0;
      }
    } else if (data.actionName) {
      this.state = STATE.WORKING;
    } else if (data.thought) {
      this.state = STATE.THINKING;
    }
  }

  update(dt) {
    // Fade in
    if (this.opacity < 1) this.opacity = Math.min(1, this.opacity + dt * 3);

    // Animation frame
    this.frameTimer += dt;
    if (this.frameTimer > 0.2) {
      this.frameTimer = 0;
      this.frame = (this.frame + 1) % 4;
    }

    const moving = this.state === STATE.ENTERING || this.state === STATE.COMPLETING || this.state === STATE.WALKING;

    if (moving && this.path.length > 0 && this.pathIdx < this.path.length) {
      const target = this.path[this.pathIdx];
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.1) {
        this.x = target.x;
        this.y = target.y;
        this.pathIdx++;
      } else {
        const step = this.speed * dt;
        this.x += (dx / dist) * Math.min(step, dist);
        this.y += (dy / dist) * Math.min(step, dist);
      }
    } else if (this.state === STATE.ENTERING && this.seat) {
      // Arrived at seat
      this.x = this.seat.x;
      this.y = this.seat.y;
      this.state = this.actionName ? STATE.WORKING : STATE.THINKING;
    } else if (this.state === STATE.COMPLETING && this.pathIdx >= this.path.length) {
      // Arrived at door — fade out
      this.opacity = Math.max(0, this.opacity - dt * 3);
    } else if (this.state === STATE.IDLE) {
      // Idle wandering
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        this.idleTimer = 2 + Math.random() * 4;
        const tx = 2 + Math.floor(Math.random() * 16);
        const ty = 3 + Math.floor(Math.random() * 7);
        this.path = findPath(Math.round(this.x), Math.round(this.y), tx, ty);
        this.pathIdx = 0;
        this.state = STATE.WALKING;
      }
    } else if (this.state === STATE.WALKING && this.pathIdx >= this.path.length) {
      this.state = STATE.IDLE;
    }
  }

  get screenX() {
    return this.x * TILE * SCALE;
  }

  get screenY() {
    return this.y * TILE * SCALE;
  }

  get isGone() {
    return this.removing && this.opacity <= 0;
  }
}

export function resetSeatCounter() {
  nextSeatIdx = 0;
}
