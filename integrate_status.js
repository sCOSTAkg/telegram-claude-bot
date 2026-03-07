const fs = require('fs');
const botPath = '/Users/guest1/Desktop/sCORP/bot.js';
let content = fs.readFileSync(botPath, 'utf8');
let modified = false;

function applyPatch(searchStr, replacementStr) {
  if (content.includes(searchStr)) {
    content = content.replace(searchStr, replacementStr);
    modified = true;
    console.log("✅ Patched: " + searchStr.substring(0, 50).trim().replace(/\n/g, ' ') + "...");
  } else {
    console.error("❌ Could not find: " + searchStr.substring(0, 50).trim().replace(/\n/g, ' ') + "...");
  }
}

function insertAfter(anchor, insertStr) {
  if (content.includes(anchor)) {
    const lines = insertStr.trim().split('\n');
    if (!content.includes(lines[0])) {
      content = content.replace(anchor, anchor + '\n' + insertStr);
      modified = true;
      console.log("✅ Inserted after: " + anchor.substring(0, 50).trim().replace(/\n/g, ' ') + "...");
    } else {
      console.log("⚠️ Already inserted after: " + anchor.substring(0, 50).trim().replace(/\n/g, ' ') + "...");
    }
  } else {
    console.error("❌ Could not find anchor: " + anchor.substring(0, 50).trim().replace(/\n/g, ' ') + "...");
  }
}

const classesCode = `
// === PROGRESS BAR CLASS ===
class ProgressBar {
  constructor(total = 100, width = 20) { this.total = total; this.width = width; this.current = 0; }
  update(current) { this.current = Math.min(current, this.total); }
  render() {
    const percent = Math.round((this.current / this.total) * 100);
    const filled = Math.round((this.current / this.total) * this.width);
    const empty = this.width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + percent + '%';
  }
  advance(delta = 1) { this.update(this.current + delta); }
  getPercent() { return Math.round((this.current / this.total) * 100); }
}

// === TASK HISTORY CLASS ===
class TaskHistory {
  constructor(maxSize = 100) { this.maxSize = maxSize; this.entries = []; }
  add(action, status = 'started', duration = 0, agent = 'system', error = null) {
    const entry = { ts: Date.now(), action, status, duration, agent, ...(error && { error }) };
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) this.entries.shift();
  }
  getRecent(count = 10) { return this.entries.slice(-count).reverse(); }
  formatForDisplay() {
    return this.getRecent(5).map(e => {
      const time = new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const status = e.status === 'completed' ? '✅' : e.status === 'error' ? '❌' : '⏳';
      const dur = e.duration > 0 ? ' (' + e.duration + 'мс)' : '';
      return status + ' ' + time + ' | ' + e.action + dur;
    }).join('\n');
  }
  clear() { this.entries = []; }
}

// === RESOURCE MONITOR CLASS ===
class ResourceMonitor {
  constructor() { this.samples = []; this.maxSamples = 60; }
  sample() {
    const mem = process.memoryUsage();
    this.samples.push({
      ts: Date.now(),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024)
    });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
  getStats() {
    if (this.samples.length === 0) return null;
    const latest = this.samples[this.samples.length - 1];
    const oldest = this.samples[0];
    const trendHeap = latest.heapUsed - oldest.heapUsed;
    return {
      heapUsed: latest.heapUsed, heapTotal: latest.heapTotal, external: latest.external,
      trend: trendHeap > 0 ? '📈' : '📉', percent: Math.round((latest.heapUsed / latest.heapTotal) * 100)
    };
  }
  formatForDisplay() {
    const stats = this.getStats();
    if (!stats) return 'N/A';
    return '💾 ' + stats.heapUsed + '/' + stats.heapTotal + 'MB (' + stats.percent + '%) ' + stats.trend;
  }
  clear() { this.samples = []; }
}

// === PHASE TRACKER CLASS ===
class PhaseTracker {
  constructor(phases = []) {
    this.phases = phases.map((p, i) => ({
      name: p, index: i, started: null, completed: null, duration: 0, status: 'pending'
    }));
    this.currentPhaseIdx = 0;
    this.startTime = Date.now();
  }
  startPhase(phaseName) {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) { phase.status = 'running'; phase.started = Date.now(); this.currentPhaseIdx = this.phases.indexOf(phase); }
  }
  completePhase(phaseName) {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) { phase.status = 'done'; phase.completed = Date.now(); phase.duration = phase.completed - phase.started; }
  }
  failPhase(phaseName, error = '') {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) { phase.status = 'error'; phase.completed = Date.now(); phase.duration = phase.completed - phase.started; phase.error = error; }
  }
  getCurrentPhase() { return this.phases[this.currentPhaseIdx]; }
  getETAms() {
    const completed = this.phases.filter(p => p.status === 'done');
    if (completed.length === 0) return null;
    const avgDuration = completed.reduce((sum, p) => sum + p.duration, 0) / completed.length;
    const remaining = this.phases.filter(p => p.status !== 'done').length;
    return avgDuration * remaining;
  }
  formatForDisplay() {
    const lines = [];
    this.phases.forEach((p, i) => {
      const icon = p.status === 'done' ? '✅' : p.status === 'running' ? '⛏️' : p.status === 'error' ? '❌' : '⏳';
      const dur = p.duration > 0 ? ' ' + p.duration + 'мс' : '';
      const marker = i === this.currentPhaseIdx ? ' ➜ ' : '   ';
      lines.push(marker + icon + ' ' + p.name + dur);
    });
    const eta = this.getETAms();
    if (eta) lines.push('\n⏱ ETA: ' + Math.round(eta / 1000) + 'с');
    return lines.join('\n');
  }
  clear() { this.phases = []; }
}
`;

insertAfter("const multiAgentTasks = new Map(); // chatId -> { orchestratorMsgId, agents: [...], log: [...], startTime }", classesCode);

const trackingMapsCode = `
// === STATUS TRACKING MAPS ===
const taskHistories = new Map();
const resourceMonitors = new Map();
const phaseTrackers = new Map();

function getTaskHistory(chatId) {
  if (!taskHistories.has(chatId)) taskHistories.set(chatId, new TaskHistory(150));
  return taskHistories.get(chatId);
}
function getResourceMonitor(chatId) {
  if (!resourceMonitors.has(chatId)) resourceMonitors.set(chatId, new ResourceMonitor());
  return resourceMonitors.get(chatId);
}
function getPhaseTracker(chatId, taskId = 'main') {
  if (!phaseTrackers.has(chatId)) phaseTrackers.set(chatId, new Map());
  const map = phaseTrackers.get(chatId);
  if (!map.has(taskId)) map.set(taskId, new PhaseTracker());
  return map.get(taskId);
}
function clearStatusTracking(chatId) {
  if (chatId) { taskHistories.delete(chatId); resourceMonitors.delete(chatId); phaseTrackers.delete(chatId); }
  else { taskHistories.clear(); resourceMonitors.clear(); phaseTrackers.clear(); }
}
`;
insertAfter("const stats = { startTime: Date.now(), messages: 0, claudeCalls: 0, errors: 0, voiceMessages: 0, files: 0, totalResponseTime: 0 };", trackingMapsCode);

const resourceMonitorCode = `
// === BACKGROUND RESOURCE MONITORING ===
let resourceMonitorInterval = null;
function startResourceMonitoring() {
  if (resourceMonitorInterval) return;
  resourceMonitorInterval = setInterval(() => {
    for (const [chatId, monitor] of resourceMonitors) { monitor.sample(); }
  }, 5000);
}
function stopResourceMonitoring() {
  if (resourceMonitorInterval) { clearInterval(resourceMonitorInterval); resourceMonitorInterval = null; }
}
startResourceMonitoring();

// === CLEANUP OLD LOGS ===
function cleanupOldStatusData() {
  const MAX_HISTORY_AGE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [chatId, history] of taskHistories) {
    const recentEntries = history.entries.filter(e => now - e.ts < MAX_HISTORY_AGE_MS);
    if (recentEntries.length < history.entries.length) history.entries = recentEntries;
  }
  for (const [chatId, monitor] of resourceMonitors) {
    if (monitor.samples.length > 120) monitor.samples = monitor.samples.slice(-60);
  }
  for (const [chatId, trackersMap] of phaseTrackers) {
    for (const [taskId, tracker] of trackersMap) {
      const isComplete = tracker.phases.every(p => p.status === 'done' || p.status === 'error');
      const createdAgo = now - tracker.startTime;
      if (isComplete && createdAgo > 60 * 60 * 1000) trackersMap.delete(taskId);
    }
    if (trackersMap.size === 0) phaseTrackers.delete(chatId);
  }
}
setInterval(cleanupOldStatusData, 60 * 60 * 1000);

// === TASK ACTION LOGGING ===
function logTaskAction(chatId, action, status = 'completed', duration = 0, agent = 'system', error = null) {
  const history = getTaskHistory(chatId);
  history.add(action, status, duration, agent, error);
  const tracker = multiAgentTasks.get(chatId);
  if (tracker && tracker.log) {
    tracker.log.push({
      ts: Date.now(),
      text: (status === 'completed' ? '✅' : status === 'error' ? '❌' : '⏳') + ' ' + action + ' (' + duration + 'мс)'
    });
  }
}
`;
insertAfter("const reminderTimers = new Map();", resourceMonitorCode);

const oldStatusBlock = `  else if (data === 'status') {
    const busy = activeTasks.has(chatId);
    const histLen = (chatHistory.get(chatId) || []).length;
    const queueLen = getQueueSize(chatId);
    const provLabel = PROVIDER_LABELS[getProvider(uc.model)] || '';
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const memCount = (getMemory(chatId) || []).length;
    const skillCount = (uc.skills || []).length;
    const langLabel = uc.language ? uc.language.slice(0, 20) : '—';
    const sysLabel = uc.systemPrompt ? \`\${uc.systemPrompt.slice(0, 40)}\${uc.systemPrompt.length > 40 ? '…' : ''}\` : '—';
    await editText(chatId, msgId,
      \`📊 Статус\\n\\n\` +
      \`┌─ 🤖 Модель ─────────\\n\` +
      \`│ \${uc.model} \${provLabel}\\n\` +
      \`│ 📁 \${uc.workDir}\\n\` +
      \`│ ⏱ \${uc.timeout}с таймаут\\n\` +
      \`└──────────────────\\n\\n\` +
      \`┌─ ⚡ Режимы ─────────\\n\` +
      \`│ 🤖 Агент \${uc.agentMode !== false ? '✅' : '❌'}  👥 Мульти \${uc.multiAgent !== false ? '✅' : '❌'}\\n\` +
      \`│ 📡 Стрим \${uc.streaming ? '✅' : '❌'}  🧠 Авто \${uc.autoModel ? '✅' : '❌'}\\n\` +
      \`│ 🔢 Шаги: \${uc.agentMaxSteps || 10}\\n\` +
      \`└──────────────────\\n\\n\` +
      \`┌─ 📈 Сессия ─────────\\n\` +
      \`│ \${busy ? '⏳ Занят' : '🔄 Свободен'} | 📬 \${queueLen} в очереди\\n\` +
      \`│ 💬 \${histLen} сообщ. | 🧠 \${memCount} памяти | ⚡ \${skillCount} навыков\\n\` +
      \`│ 🌐 \${langLabel} | 💬 \${sysLabel}\\n\` +
      \`│ ⏱ \${uptime}м аптайм | 🤖 AI: \${activeClaudeCount}/\${MAX_CLAUDE_PROCS}\\n\` +
      \`└──────────────────\`,
      mainMenu(chatId));
  }`;

const newStatusBlock = `  else if (data === 'status') {
    const busy = activeTasks.has(chatId);
    const histLen = (chatHistory.get(chatId) || []).length;
    const queueLen = getQueueSize(chatId);
    const provLabel = PROVIDER_LABELS[getProvider(uc.model)] || '';
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const memCount = (getMemory(chatId) || []).length;
    const skillCount = (uc.skills || []).length;
    const langLabel = uc.language ? uc.language.slice(0, 20) : '—';
    const sysLabel = uc.systemPrompt ? \`\${uc.systemPrompt.slice(0, 40)}\${uc.systemPrompt.length > 40 ? '…' : ''}\` : '—';

    // ===== НОВОЕ: Получаем ресурсы и историю =====
    const taskHist = getTaskHistory(chatId);
    const resourceMonitor = getResourceMonitor(chatId);
    const resourceStats = resourceMonitor.getStats();
    const recentHistory = taskHist.getRecent(3);

    let historyText = '';
    if (recentHistory.length > 0) {
      historyText = '\\n┌─ 📜 История (последние 3) ─\\n';
      for (const entry of recentHistory) {
        const time = new Date(entry.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const stIcon = entry.status === 'completed' ? '✅' : entry.status === 'error' ? '❌' : '⏳';
        historyText += \`│ \${stIcon} \${time} \${entry.action}\\n\`;
      }
      historyText += '└──────────────────\\n';
    }

    let resourceText = '';
    if (resourceStats) {
      resourceText = \`\\n┌─ 💾 Ресурсы ─────────\\n\` +
        \`│ Память: \${resourceStats.heapUsed}/\${resourceStats.heapTotal}MB (\${resourceStats.percent}%) \${resourceStats.trend}\\n\` +
        \`└──────────────────\\n\`;
    }

    await editText(chatId, msgId,
      \`📊 Статус\\n\\n\` +
      \`┌─ 🤖 Модель ─────────\\n\` +
      \`│ \${uc.model} \${provLabel}\\n\` +
      \`│ 📁 \${uc.workDir}\\n\` +
      \`│ ⏱ \${uc.timeout}с таймаут\\n\` +
      \`└──────────────────\\n\\n\` +
      \`┌─ ⚡ Режимы ─────────\\n\` +
      \`│ 🤖 Агент \${uc.agentMode !== false ? '✅' : '❌'}  👥 Мульти \${uc.multiAgent !== false ? '✅' : '❌'}\\n\` +
      \`│ 📡 Стрим \${uc.streaming ? '✅' : '❌'}  🧠 Авто \${uc.autoModel ? '✅' : '❌'}\\n\` +
      \`│ 🔢 Шаги: \${uc.agentMaxSteps || 10}\\n\` +
      \`└──────────────────\\n\\n\` +
      \`┌─ 📈 Сессия ─────────\\n\` +
      \`│ \${busy ? '⏳ Занят' : '🔄 Свободен'} | 📬 \${queueLen} в очереди\\n\` +
      \`│ 💬 \${histLen} сообщ. | 🧠 \${memCount} памяти | ⚡ \${skillCount} навыков\\n\` +
      \`│ 🌐 \${langLabel} | 💬 \${sysLabel}\\n\` +
      \`│ ⏱ \${uptime}м аптайм | 🤖 AI: \${activeClaudeCount}/\${MAX_CLAUDE_PROCS}\\n\` +
      \`└──────────────────\` +
      resourceText +
      historyText,
      mainMenu(chatId));
  }`;

applyPatch(oldStatusBlock, newStatusBlock);

if (modified) {
  fs.writeFileSync(botPath, content, 'utf8');
  console.log('✅ bot.js updated successfully!');
} else {
  console.log('⚠️ No modifications were made.');
}
