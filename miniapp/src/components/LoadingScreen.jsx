import React from 'react';

export default function LoadingScreen({ error }) {
  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-icon">🎮</div>
        <h1>Pixel Office</h1>
        {error ? (
          <>
            <p className="error-text">Нет подключения к боту</p>
            <p className="error-detail">{error}</p>
            <p className="hint">Попробуйте позже или напишите боту</p>
          </>
        ) : (
          <>
            <div className="loading-dots">
              <span>.</span><span>.</span><span>.</span>
            </div>
            <p className="hint">Подключение к sCORP...</p>
          </>
        )}
      </div>
    </div>
  );
}
