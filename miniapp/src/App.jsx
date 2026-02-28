import React from 'react';
import { useTelegramWebApp } from './hooks/useTelegramWebApp.js';
import { useAgentStream } from './hooks/useAgentStream.js';
import PixelOffice from './components/PixelOffice.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';

export default function App() {
  const { initData, viewportHeight } = useTelegramWebApp();
  const { state, connected, error } = useAgentStream(initData);

  if (!connected && !state) {
    return <LoadingScreen error={error} />;
  }

  return (
    <div className="app">
      <PixelOffice agentState={state} viewportHeight={viewportHeight} />
    </div>
  );
}
