import React, { useRef, useEffect, useState, useCallback } from 'react';
import { CANVAS_W, CANVAS_H, TILE, SCALE, STATE } from '../engine/constants.js';
import { GameLoop } from '../engine/GameLoop.js';
import { Renderer } from '../engine/Renderer.js';
import { Character, resetSeatCounter } from '../engine/Character.js';
import AgentPanel from './AgentPanel.jsx';

export default function PixelOffice({ agentState, viewportHeight }) {
  const canvasRef = useRef(null);
  const charsRef = useRef(new Map()); // id -> Character
  const rendererRef = useRef(null);
  const loopRef = useRef(null);
  const [selectedChar, setSelectedChar] = useState(null);

  // Map SSE state to characters
  useEffect(() => {
    if (!agentState) return;
    const chars = charsRef.current;
    const activeIds = new Set();

    // Foreground task
    if (agentState.foreground) {
      const fg = agentState.foreground;
      const fgId = 'fg_main';
      activeIds.add(fgId);
      if (!chars.has(fgId)) {
        const role = fg.status?.phase?.includes('субагент') ? 'orchestrator' : 'coder';
        const roles = agentState.agentRoles || {};
        const roleInfo = roles[role] || { icon: '🤖', label: 'Агент' };
        const ch = new Character(fgId, role, roleInfo.icon, roleInfo.label);
        ch.assignSeat(false);
        chars.set(fgId, ch);
      }
      const ch = chars.get(fgId);
      ch.updateFromData({
        status: 'running',
        actionName: fg.status?.actionName,
        actionDetail: fg.status?.actionDetail,
        thought: fg.status?.thought,
        step: fg.status?.step || 0,
        maxSteps: fg.status?.maxSteps || 0,
        phase: fg.status?.phase,
        error: fg.status?.error,
        startTime: fg.startTime,
      });
    }

    // Background tasks
    if (agentState.background) {
      for (const bg of agentState.background) {
        const bgId = `bg_${bg.id}`;
        activeIds.add(bgId);
        if (!chars.has(bgId)) {
          const ch = new Character(bgId, 'executor', '⚡', 'Фоновый');
          ch.assignSeat(false);
          chars.set(bgId, ch);
        }
        const ch = chars.get(bgId);
        ch.updateFromData({
          status: bg.status === 'done' ? 'done' : 'running',
          phase: bg.prompt?.slice(0, 30),
          startTime: bg.startTime,
        });
      }
    }

    // Multi-agent tasks
    if (agentState.multiAgent?.agents) {
      for (let i = 0; i < agentState.multiAgent.agents.length; i++) {
        const agent = agentState.multiAgent.agents[i];
        const maId = `ma_${i}_${agent.role}`;
        activeIds.add(maId);
        if (!chars.has(maId)) {
          const roles = agentState.agentRoles || {};
          const roleInfo = roles[agent.role] || { icon: '🤖', label: agent.role };
          const ch = new Character(maId, agent.role, roleInfo.icon, roleInfo.label);
          const isMeeting = agent.role === 'orchestrator';
          ch.assignSeat(isMeeting);
          chars.set(maId, ch);
        }
        const ch = chars.get(maId);
        ch.updateFromData({
          status: agent.status === 'completed' ? 'done' : agent.status === 'error' ? 'error' : 'running',
          startTime: agent.startTime || agentState.multiAgent.startTime,
        });
      }
    }

    // Remove characters for tasks that no longer exist
    for (const [id, ch] of chars) {
      if (!activeIds.has(id) && ch.state !== STATE.COMPLETING && ch.state !== STATE.IDLE) {
        ch.updateFromData({ status: 'done' });
      }
    }

    // Cleanup gone characters
    for (const [id, ch] of chars) {
      if (ch.isGone) chars.delete(id);
    }

    // Update selected character ref
    if (selectedChar && !chars.has(selectedChar.id)) {
      setSelectedChar(null);
    } else if (selectedChar) {
      setSelectedChar(chars.get(selectedChar.id));
    }
  }, [agentState]);

  // Canvas click handler
  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    const S = TILE * SCALE;
    let found = null;
    for (const [, ch] of charsRef.current) {
      if (cx >= ch.screenX && cx <= ch.screenX + S && cy >= ch.screenY && cy <= ch.screenY + S) {
        found = ch;
        break;
      }
    }
    setSelectedChar(found);
  }, []);

  // Setup game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    rendererRef.current = new Renderer(ctx);

    const loop = new GameLoop(
      (dt) => {
        for (const [, ch] of charsRef.current) {
          ch.update(dt);
        }
      },
      () => {
        const chars = [...charsRef.current.values()];
        const globalState = agentState ? {
          activeClaudeCount: agentState.global?.activeClaudeCount || 0,
          maxClaude: agentState.global?.maxClaude || 3,
          queueSize: agentState.queueSize || 0,
        } : null;
        rendererRef.current.render(chars, globalState);
      }
    );

    loopRef.current = loop;
    loop.start();

    return () => loop.stop();
  }, []);

  // Compute canvas CSS size to fit viewport
  const aspect = CANVAS_W / CANVAS_H;
  const maxW = Math.min(window.innerWidth, 960);
  const maxH = viewportHeight - 20;
  let cssW, cssH;
  if (maxW / maxH > aspect) {
    cssH = maxH;
    cssW = cssH * aspect;
  } else {
    cssW = maxW;
    cssH = cssW / aspect;
  }

  // Empty office message
  const isEmpty = !agentState?.foreground && (!agentState?.background || agentState.background.length === 0) && (!agentState?.multiAgent?.agents || agentState.multiAgent.agents.length === 0);

  return (
    <div className="pixel-office-container">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ width: cssW, height: cssH }}
        onClick={handleClick}
      />
      {isEmpty && (
        <div className="empty-office-msg">
          <p>🏢 Офис пуст</p>
          <p className="hint">Напиши боту что-нибудь — и агенты появятся!</p>
        </div>
      )}
      {selectedChar && (
        <AgentPanel character={selectedChar} onClose={() => setSelectedChar(null)} />
      )}
    </div>
  );
}
