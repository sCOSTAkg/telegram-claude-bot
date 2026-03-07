import React, { useState, useEffect, useRef } from 'react';
import { STATE } from '../engine/constants.js';

export default function StatsBar({ agentState, characters }) {
  const [elapsed, setElapsed] = useState('0:00');
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;

  const activeCount = characters
    ? [...characters.values()].filter(c =>
        c.state === STATE.WORKING || c.state === STATE.THINKING || c.state === STATE.MEETING
      ).length
    : 0;

  const claudeActive = agentState?.global?.activeClaudeCount || 0;
  const claudeMax = agentState?.global?.maxClaude || 3;
  const queueSize = agentState?.queueSize || 0;

  useEffect(() => {
    if (activeCount === 0) { setElapsed('0:00'); return; }

    const update = () => {
      const state = agentStateRef.current;
      let earliest = Infinity;
      if (state?.foreground?.startTime) earliest = Math.min(earliest, state.foreground.startTime);
      if (state?.multiAgent?.startTime) earliest = Math.min(earliest, state.multiAgent.startTime);
      if (Array.isArray(state?.background)) {
        for (const bg of state.background) {
          if (bg.startTime) earliest = Math.min(earliest, bg.startTime);
        }
      }
      if (earliest < Infinity) {
        const s = Math.round((Date.now() - earliest) / 1000);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        setElapsed(`${m}:${String(sec).padStart(2, '0')}`);
      }
    };

    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [activeCount]);

  const cards = [
    { icon: '\u{1F916}', value: `${claudeActive}/${claudeMax}`, label: 'AI', active: claudeActive > 0 },
    { icon: '\u{1F4EC}', value: queueSize, label: '\u041E\u0447\u0435\u0440\u0435\u0434\u044C', active: queueSize > 0 },
    { icon: '\u26A1', value: activeCount, label: '\u0410\u043A\u0442\u0438\u0432\u043D\u044B', active: activeCount > 0 },
    { icon: '\u23F1', value: elapsed, label: '\u0412\u0440\u0435\u043C\u044F', active: activeCount > 0 },
  ];

  return (
    <div className="stats-grid">
      {cards.map((card, i) => (
        <div key={i} className={`stat-card ${card.active ? 'stat-card-active' : ''}`}>
          <span className="stat-card-icon">{card.icon}</span>
          <span className="stat-card-value">{card.value}</span>
          <span className="stat-card-label">{card.label}</span>
        </div>
      ))}
    </div>
  );
}
