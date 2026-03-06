import React, { useState, useEffect, useRef } from 'react';
import { STATE } from '../engine/constants.js';

export default function MonitorPanel({ agentState, characters, agentCounts }) {
  const [elapsed, setElapsed] = useState('00:00');
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;

  const claudeActive = agentState?.global?.activeClaudeCount || 0;
  const claudeMax = agentState?.global?.maxClaude || 3;
  const queueSize = agentState?.queueSize || 0;
  const { working, thinking, idle, errors, active, total } = agentCounts;

  useEffect(() => {
    if (active === 0) { setElapsed('00:00'); return; }

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
        setElapsed(`${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`);
      }
    };

    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [active]);

  return (
    <div className="monitor-panel">
      {/* Left monitor — Prisoners count */}
      <div className="monitor-screen monitor-left">
        <div className="monitor-frame">
          <div className="monitor-header">
            <span className="monitor-dot green" />
            <span className="monitor-title">PRISONERS</span>
          </div>
          <div className="monitor-body">
            <span className="monitor-big-number">{String(active).padStart(2, '0')}</span>
            <span className="monitor-small-label">Active</span>
          </div>
          <div className="monitor-footer">
            <span className="monitor-stat">
              <span className="dot-green" /> {working} working
            </span>
            <span className="monitor-stat">
              <span className="dot-orange" /> {thinking} thinking
            </span>
          </div>
        </div>
      </div>

      {/* Center monitor — Queue & Status */}
      <div className="monitor-screen monitor-center">
        <div className="monitor-frame">
          <div className="monitor-header">
            <span className="monitor-dot blue" />
            <span className="monitor-title">CONTROL</span>
          </div>
          <div className="monitor-body">
            <span className="monitor-big-number">{String(claudeActive).padStart(2, '0')}</span>
            <span className="monitor-small-label">AI / {claudeMax}</span>
          </div>
          <div className="monitor-footer">
            <span className="monitor-stat">
              <span className="dot-blue" /> Queue: {queueSize}
            </span>
            <span className="monitor-stat">
              ⏱ {elapsed}
            </span>
          </div>
        </div>
      </div>

      {/* Right monitor — Errors */}
      <div className="monitor-screen monitor-right">
        <div className="monitor-frame">
          <div className="monitor-header">
            <span className={`monitor-dot ${errors > 0 ? 'red blink' : 'dim'}`} />
            <span className="monitor-title">INCIDENTS</span>
          </div>
          <div className="monitor-body">
            <span className={`monitor-big-number ${errors > 0 ? 'number-red' : ''}`}>
              {String(errors).padStart(2, '0')}
            </span>
            <span className="monitor-small-label">Errors</span>
          </div>
          <div className="monitor-footer">
            <span className="monitor-stat">
              {idle} idle
            </span>
            <span className="monitor-stat">
              {total} total
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
