import React, { useState, useEffect, useMemo } from 'react';
import { STATE, ROLE_HUES, hashToHue, ALL_ROLES } from '../engine/constants.js';

const DEFAULT_ROLE_INFO = {
  orchestrator: { icon: '\u{1F46E}', label: '\u041D\u0430\u0434\u0437\u0438\u0440\u0430\u0442\u0435\u043B\u044C' },
  coder: { icon: '\u{1F4BB}', label: '\u041A\u043E\u0434\u0435\u0440' },
  researcher: { icon: '\u{1F50D}', label: '\u0420\u0435\u0441\u0451\u0440\u0447\u0435\u0440' },
  reviewer: { icon: '\u{1F9D0}', label: '\u0420\u0435\u0432\u044C\u044E\u0435\u0440' },
  writer: { icon: '\u270D\uFE0F', label: '\u041F\u0438\u0441\u0430\u0442\u0435\u043B\u044C' },
  executor: { icon: '\u26A1', label: '\u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C' },
  python_dev: { icon: '\u{1F40D}', label: 'Python' },
  web_dev: { icon: '\u{1F310}', label: 'Web Dev' },
  data_analyst: { icon: '\u{1F4CA}', label: '\u0410\u043D\u0430\u043B\u0438\u0442\u0438\u043A' },
  devops: { icon: '\u2699\uFE0F', label: 'DevOps' },
  security: { icon: '\u{1F6E1}\uFE0F', label: 'Security' },
  technical_writer: { icon: '\u{1F4DD}', label: '\u0422\u0435\u0445.\u043F\u0438\u0441.' },
  seo: { icon: '\u{1F4C8}', label: 'SEO' },
  social_media: { icon: '\u{1F4F1}', label: 'SMM' },
  content_creator: { icon: '\u{1F3A8}', label: '\u041A\u043E\u043D\u0442\u0435\u043D\u0442' },
  translator: { icon: '\u{1F30D}', label: '\u041F\u0435\u0440\u0435\u0432\u043E\u0434' },
  ux_ui_designer: { icon: '\u{1F3A8}', label: 'UX/UI' },
};

function getCardStatus(chState) {
  switch (chState) {
    case STATE.WORKING: return { badge: 'WORKING', cls: 'badge-working' };
    case STATE.THINKING: return { badge: 'THINKING', cls: 'badge-thinking' };
    case STATE.MEETING: return { badge: 'MEETING', cls: 'badge-meeting' };
    case STATE.ERROR: return { badge: 'ERROR', cls: 'badge-error-label' };
    default: return { badge: 'IDLE', cls: 'badge-idle-label' };
  }
}

export default function AgentStrip({ characters, agentState, selectedRole, onSelect, charsVersion }) {
  const [filter, setFilter] = useState('all');
  const [, setTick] = useState(0);

  const { sorted, activeCount, errorCount, totalCount } = useMemo(() => {
    const cards = ALL_ROLES.map(role => {
      const ch = characters?.get(`resident_${role}`);
      const roleInfo = agentState?.agentRoles?.[role] || DEFAULT_ROLE_INFO[role] || { icon: '\u{1F916}', label: role };
      const hue = ROLE_HUES[role] ?? hashToHue(role);
      const isActive = ch && (ch.state === STATE.WORKING || ch.state === STATE.THINKING || ch.state === STATE.MEETING);
      const isError = ch?.state === STATE.ERROR;
      const status = getCardStatus(ch?.state);

      return {
        role,
        icon: roleInfo.icon || DEFAULT_ROLE_INFO[role]?.icon || '\u{1F916}',
        label: roleInfo.label || DEFAULT_ROLE_INFO[role]?.label || role,
        hue,
        isActive,
        isError,
        state: ch?.state || STATE.IDLE_DESK,
        character: ch,
        status,
        actionName: ch?.actionName,
        actionDetail: ch?.actionDetail,
        thought: ch?.thought,
        step: ch?.step || 0,
        maxSteps: ch?.maxSteps || 0,
        startTime: ch?.startTime,
      };
    });

    const sorted = cards.slice().sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isError && !b.isError) return -1;
      if (!a.isError && b.isError) return 1;
      return 0;
    });

    let activeCount = 0, errorCount = 0;
    for (const c of cards) {
      if (c.isActive) activeCount++;
      if (c.isError) errorCount++;
    }

    return { sorted, activeCount, errorCount, totalCount: cards.length };
  }, [agentState, characters, charsVersion]);

  const filtered = sorted.filter(card => {
    if (filter === 'active') return card.isActive;
    if (filter === 'error') return card.isError;
    return true;
  });

  const getElapsed = (startTime) => {
    if (!startTime) return '';
    const s = Math.max(0, Math.round((Date.now() - startTime) / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  useEffect(() => {
    if (activeCount === 0) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [activeCount]);

  return (
    <>
      <div className="filter-tabs">
        <button
          className={`filter-tab ${filter === 'all' ? 'filter-tab-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          {'\u0412\u0441\u0435'} {totalCount}
        </button>
        <button
          className={`filter-tab ${filter === 'active' ? 'filter-tab-active' : ''}`}
          onClick={() => setFilter('active')}
        >
          {'\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0435'} {activeCount}
        </button>
        {errorCount > 0 && (
          <button
            className={`filter-tab filter-tab-error ${filter === 'error' ? 'filter-tab-active' : ''}`}
            onClick={() => setFilter('error')}
          >
            ! {errorCount}
          </button>
        )}
      </div>

      <div className="agent-list">
        {filtered.map(card => {
          const isSelected = selectedRole === card.role;
          const cardType = card.isActive ? 'card-active' : card.isError ? 'card-error' : 'card-idle';
          const progress = card.maxSteps > 0 ? Math.min(card.step / card.maxSteps, 1) : 0;

          return (
            <div
              key={card.role}
              className={`agent-card-full ${cardType} ${isSelected ? 'card-selected' : ''}`}
              onClick={() => onSelect(card.character)}
            >
              <div className="agent-card-avatar">
                <span>{card.icon}</span>
              </div>

              <div className="agent-card-body">
                <div className="agent-card-top">
                  <span className="agent-card-name">{card.label}</span>
                  <span className={`agent-card-badge ${card.status.cls}`}>{card.status.badge}</span>
                </div>

                {card.isActive && card.actionName && (
                  <div className="agent-card-action">
                    {'\u26A1'} {card.actionName}{card.actionDetail ? `: ${card.actionDetail.slice(0, 40)}` : ''}
                  </div>
                )}

                {card.isActive && !card.actionName && card.thought && (
                  <div className="agent-card-thought">
                    {'\u{1F4AD}'} {card.thought.slice(0, 50)}
                  </div>
                )}

                {card.isActive && card.maxSteps > 0 && (
                  <div className="agent-card-progress">
                    <div className="progress-bar-track">
                      <div className="progress-bar-fill" style={{ width: `${progress * 100}%` }} />
                    </div>
                    <span className="progress-bar-text">{Math.round(progress * 100)}%</span>
                  </div>
                )}
              </div>

              {card.isActive && (
                <span className="agent-card-timer">{getElapsed(card.startTime)}</span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
