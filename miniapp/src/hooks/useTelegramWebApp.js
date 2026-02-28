import { useEffect, useState } from 'react';

export function useTelegramWebApp() {
  const [webApp, setWebApp] = useState(null);
  const [initData, setInitData] = useState('');
  const [user, setUser] = useState(null);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    tg.ready();
    tg.expand();

    // Dark theme
    tg.setHeaderColor('#030014');
    tg.setBackgroundColor('#030014');

    setWebApp(tg);
    setInitData(tg.initData || '');
    setUser(tg.initDataUnsafe?.user || null);
    setViewportHeight(tg.viewportStableHeight || window.innerHeight);

    const onViewport = () => {
      setViewportHeight(tg.viewportStableHeight || window.innerHeight);
    };
    tg.onEvent('viewportChanged', onViewport);

    return () => tg.offEvent('viewportChanged', onViewport);
  }, []);

  return { webApp, initData, user, viewportHeight };
}
