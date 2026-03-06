import React, { useState, useEffect } from 'react';
import { STATE, TILE, SCALE, CANVAS_W, CANVAS_H } from '../engine/constants.js';

/* Reference: colored translucent tags (green, orange, purple, red) */
const STATUS_LABELS = {
  [STATE.WORKING]: { text: 'WORKING', color: '#22c55e', bg: 'rgba(34,197,94,0.28)' },
  [STATE.THINKING]: { text: 'THINKING', color: '#f97316', bg: 'rgba(249,115,22,0.28)' },
  [STATE.MEETING]: { text: 'MEETING', color: '#a78bfa', bg: 'rgba(167,139,250,0.28)' },
  [STATE.ERROR]: { text: 'ERROR', color: '#ef4444', bg: 'rgba(239,68,68,0.28)' },
};

export default function StatusOverlay({ characters, charsVersion }) {
  const [, setTick] = useState(0);

  // Re-render when characters sync from API (charsVersion) or every 2s for positions
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(iv);
  }, []);

  if (!characters || characters.size === 0) return null;

  const labels = [];
  for (const [id, ch] of characters) {
    const cfg = STATUS_LABELS[ch.state];
    if (!cfg) continue;
    if (ch.opacity < 0.5) continue;

    // Convert screen coords to percentage of canvas
    const px = ((ch.screenX + TILE * SCALE / 2) / CANVAS_W) * 100;
    const py = ((ch.screenY) / CANVAS_H) * 100;

    // Get display text — use actionName if working, thought if thinking
    let displayText = cfg.text;
    if (ch.state === STATE.WORKING && ch.actionName) {
      displayText = ch.actionName.toUpperCase().slice(0, 14);
    } else if (ch.state === STATE.THINKING && ch.thought) {
      displayText = ch.thought.slice(0, 14).toUpperCase();
    }

    labels.push({
      id,
      text: displayText,
      color: cfg.color,
      bg: cfg.bg,
      x: px,
      y: py,
      label: ch.label || ch.role,
    });
  }

  if (labels.length === 0) return null;

  return (
    <div className="status-overlay">
      {labels.map(l => (
        <div
          key={l.id}
          className="status-float-label"
          style={{
            left: `${Math.min(85, Math.max(5, l.x))}%`,
            top: `${Math.max(2, l.y - 8)}%`,
            '--label-color': l.color,
            '--label-bg': l.bg,
          }}
        >
          <span className="float-label-dot" style={{ background: l.color }} />
          <span className="float-label-text">{l.text}</span>
        </div>
      ))}
    </div>
  );
}
