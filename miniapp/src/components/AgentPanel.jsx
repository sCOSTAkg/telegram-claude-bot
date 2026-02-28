import React from 'react';

export default function AgentPanel({ character, onClose }) {
  if (!character) return null;

  const elapsed = character.startTime
    ? Math.round((Date.now() - character.startTime) / 1000)
    : 0;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <div className="agent-panel" onClick={(e) => e.target.className === 'agent-panel' && onClose()}>
      <div className="agent-panel-content">
        <div className="agent-panel-header">
          <span className="agent-icon">{character.icon}</span>
          <div>
            <h3>{character.label}</h3>
            <span className="agent-role">{character.role}</span>
          </div>
          <button className="panel-close" onClick={onClose}>✕</button>
        </div>

        <div className="agent-panel-body">
          <div className="agent-stat">
            <span className="stat-label">Статус</span>
            <span className="stat-value">{character.phase || character.state}</span>
          </div>

          {character.step > 0 && character.maxSteps > 0 && (
            <div className="agent-stat">
              <span className="stat-label">Прогресс</span>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(character.step / character.maxSteps) * 100}%` }}
                />
                <span className="progress-text">{character.step}/{character.maxSteps}</span>
              </div>
            </div>
          )}

          {character.actionName && (
            <div className="agent-stat">
              <span className="stat-label">Действие</span>
              <span className="stat-value action">⚡ {character.actionName}
                {character.actionDetail && `: ${character.actionDetail.slice(0, 50)}`}
              </span>
            </div>
          )}

          {character.thought && (
            <div className="agent-stat">
              <span className="stat-label">Мысль</span>
              <span className="stat-value thought">💭 {character.thought.slice(0, 100)}</span>
            </div>
          )}

          <div className="agent-stat">
            <span className="stat-label">Время</span>
            <span className="stat-value">{minutes > 0 ? `${minutes}м ` : ''}{seconds}с</span>
          </div>
        </div>
      </div>
    </div>
  );
}
