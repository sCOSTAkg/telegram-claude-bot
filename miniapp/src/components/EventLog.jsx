import React, { useRef, useEffect, useState, useMemo } from 'react';

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getLogIcon(text) {
  if (!text) return '\u{1F4CB}';
  const t = text.toLowerCase();
  if (t.includes('\u043E\u0440\u043A\u0435\u0441\u0442\u0440\u0430\u0442\u043E\u0440') || t.includes('\u0434\u0435\u043B\u0435\u0433\u0438\u0440')) return '\u{1F3AF}';
  if (t.includes('\u043A\u043E\u0434\u0435\u0440') || t.includes('\u043A\u043E\u0434')) return '\u{1F4BB}';
  if (t.includes('\u0440\u0435\u0441\u0451\u0440\u0447\u0435\u0440') || t.includes('\u043F\u043E\u0438\u0441\u043A')) return '\u{1F50D}';
  if (t.includes('\u0440\u0435\u0432\u044C\u044E')) return '\u{1F9D0}';
  if (t.includes('\u043E\u0448\u0438\u0431\u043A') || t.includes('error')) return '\u274C';
  if (t.includes('\u0433\u043E\u0442\u043E\u0432') || t.includes('\u0437\u0430\u0432\u0435\u0440') || t.includes('done')) return '\u2705';
  if (t.includes('\u043D\u0430\u0447\u0430\u043B') || t.includes('start')) return '\u25B6\uFE0F';
  return '\u{1F4CB}';
}

export default function EventLog({ agentState }) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef(null);
  const prevLenRef = useRef(0);

  const trimmed = useMemo(() => {
    const entries = [];

    if (agentState?.multiAgent?.log) {
      for (const entry of agentState.multiAgent.log) {
        const text = typeof entry === 'string' ? entry : entry.text;
        const ts = typeof entry === 'object' ? entry.ts : null;
        if (text) entries.push({ text, ts, icon: getLogIcon(text) });
      }
    }

    if (agentState?.foreground?.status) {
      const s = agentState.foreground.status;
      if (s.phase) {
        entries.push({
          text: `${s.phase}${s.actionName ? ` \u2192 ${s.actionName}` : ''}`,
          ts: Date.now(),
          icon: '\u26A1',
        });
      }
    }

    return entries.slice(-30);
  }, [agentState]);
  const visible = expanded ? trimmed : trimmed.slice(-3);

  useEffect(() => {
    if (trimmed.length > prevLenRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = trimmed.length;
  }, [trimmed.length]);

  if (trimmed.length === 0) return null;

  return (
    <div className="event-log-section">
      <div className="event-log-header" onClick={() => setExpanded(!expanded)}>
        <span>{'\u{1F4CB}'} \u041B\u043E\u0433 \u0441\u043E\u0431\u044B\u0442\u0438\u0439</span>
        <span className="event-log-count">{trimmed.length}</span>
        <span className={`event-log-toggle ${expanded ? 'event-log-toggle-expanded' : ''}`}>{'\u25BC'}</span>
      </div>
      <div className={`event-log ${expanded ? 'event-log-expanded' : ''}`} ref={scrollRef}>
        {visible.map((entry, i) => (
          <div key={i} className={`event-log-item ${i === visible.length - 1 ? 'event-log-item-new' : ''}`}>
            <span className="event-log-icon">{entry.icon}</span>
            {entry.ts && <span className="event-log-time">{formatTime(entry.ts)}</span>}
            <span className="event-log-text">{entry.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
