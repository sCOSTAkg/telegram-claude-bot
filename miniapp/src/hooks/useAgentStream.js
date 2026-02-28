import { useEffect, useRef, useState, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'https://scorp.up.railway.app';

export function useAgentStream(initData) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const retriesRef = useRef(0);

  const buildUrl = useCallback((endpoint) => {
    const params = new URLSearchParams();
    if (initData) params.set('initData', initData);
    return `${API_BASE}/api/${endpoint}?${params.toString()}`;
  }, [initData]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const poll = async () => {
      try {
        const res = await fetch(buildUrl('state'));
        if (res.ok) {
          const data = await res.json();
          setState(data);
          setConnected(true);
          setError(null);
          retriesRef.current = 0;
        } else {
          const body = await res.text().catch(() => '');
          setError(`HTTP ${res.status}: ${body.slice(0, 50)}`);
        }
      } catch (err) {
        retriesRef.current++;
        setError(err.message);
        if (retriesRef.current > 5) setConnected(false);
      }
    };
    poll();
    pollRef.current = setInterval(poll, 1500);
  }, [buildUrl]);

  const connect = useCallback(() => {
    // Try SSE first
    try {
      const url = buildUrl('agents');
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        setConnected(true);
        setError(null);
        retriesRef.current = 0;
      };

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          setState(data);
          setConnected(true);
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        // Fallback to polling
        startPolling();
      };
    } catch {
      startPolling();
    }
  }, [buildUrl, startPolling]);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [connect]);

  // Reconnect after disconnect
  useEffect(() => {
    if (!connected && !esRef.current && !pollRef.current) {
      const timer = setTimeout(connect, 3000);
      return () => clearTimeout(timer);
    }
  }, [connected, connect]);

  return { state, connected, error };
}
