const crypto = require('crypto');

function validateInitData(initDataStr, botToken) {
  try {
    if (!initDataStr || !botToken) return null;
    const params = new URLSearchParams(initDataStr);
    const hash = params.get('hash');
    if (!hash) return null;

    const sorted = [];
    for (const [k, v] of params.entries()) if (k !== 'hash') sorted.push(`${k}=${v}`);
    sorted.sort();
    const dataCheckString = sorted.join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calcHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch (_) {
    return null;
  }
}

function serializeMiniAppState({ chatId, activeTasks, backgroundTasks, multiAgent, activeClaudeCount }) {
  const fg = activeTasks.get(chatId);
  const bgMap = backgroundTasks.get(chatId);
  const bgList = bgMap ? Array.from(bgMap.values()).map((t) => ({
    id: t.id,
    title: t.title || t.task?.slice(0, 80) || 'Background task',
    status: t.status || 'running',
    startedAt: t.startedAt || t.startTime || Date.now(),
    progress: t.progress || 0,
  })) : [];

  return {
    foreground: fg ? Array.from(fg.values()) : [],
    background: bgList,
    multiAgent,
    global: { activeClaudeCount },
  };
}

module.exports = { validateInitData, serializeMiniAppState };
