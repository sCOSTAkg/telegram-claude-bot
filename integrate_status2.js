const fs = require('fs');
const botPath = '/Users/guest1/Desktop/sCORP/bot.js';
let content = fs.readFileSync(botPath, 'utf8');

let modified = false;

function patchRegExp(pattern, replacement) {
  if (pattern.test(content)) {
    content = content.replace(pattern, replacement);
    modified = true;
    console.log("✅ Patched: " + pattern.toString().substring(0, 50));
  } else {
    console.error("❌ Not found: " + pattern.toString().substring(0, 50));
  }
}

// 2.1 Maps - inserting after const stats = { ... };
const statsAnchor = /const stats = \{ startTime: Date\.now\(\)[^;]+;/;
const mapsCode = `
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
patchRegExp(statsAnchor, (match) => match + "
" + mapsCode);

// 4.1 Update prison_blocks
// We want to replace the body of the `for (const sa of agents)` loop in `prison_blocks` command handler.
const pbPattern = /for \([^\)]+of agents\) \{\s*const effectiveRoles = getEffectiveAgents\(chatId\);\s*const ri = [^
]+
\s*const num = [^
]+
\s*const langTag = [^
]+
\s*const modelTag = [^
]+
\s*const dur = [^
]+
\s*const statusIcon = [^
]+
\s*text \+= [^
]+
\s*if \(sa\.task\)[^
]+
\s*\}/g;

const pbNew = `for (const sa of agents) {
          const effectiveRoles = getEffectiveAgents(chatId);
          const ri = effectiveRoles[sa.role] || AGENT_ROLES[sa.role] || { icon: '🔄', label: sa.role };
          const num = sa.inmateNum || '???';
          const langTag = sa.language ? ` \${PRISON_CONFIG.languageLabels[sa.language] || sa.language}` : '';
          const modelTag = sa.model ? ` [\${sa.model}]` : '';

          let dur = '';
          let progressBar = '';
          if (sa.status === 'running') {
            const elapsed = Math.round((Date.now() - sa.startTime) / 1000);
            dur = `\${elapsed}с`;
            const percent = Math.min(Math.round((elapsed / 20) * 100), 95);
            try {
               const bar = new ProgressBar(100, 15);
               bar.update(percent);
               progressBar = ` \${bar.render()}`;
            } catch(e) {}
          } else if (sa.endTime) {
            dur = `\${Math.round((sa.endTime - sa.startTime) / 1000)}с`;
          }

          const statusIcon = sa.status === 'running' ? '⛏️' : sa.status === 'done' ? '✅' : '❌';
          text += `  \${statusIcon} #\${num} \${ri.icon} \${ri.label}\${langTag}\${modelTag} \${dur}
`;
          if (progressBar) text += `     \${progressBar}
`;
          if (sa.task) text += `     📋 \${sa.task.slice(0, 50)}
`;
          if (sa.error) text += `     ⚠️ \${sa.error.slice(0, 40)}
`;
          if (sa.phase && sa.status === 'running') text += `     🔄 Фаза: \${sa.phase}
`;
        }`;

patchRegExp(pbPattern, pbNew);


// 5.1 executeCouncilAction updates
const cInitOld = /const tier = typeMatch \? typeMatch\[1\]\.toLowerCase\(\) : 'balanced';\s*const models = COUNCIL_MODELS\[tier\] \|\| COUNCIL_MODELS\.balanced;/;

const cInitNew = `const tier = typeMatch ? typeMatch[1].toLowerCase() : 'balanced';
  const models = COUNCIL_MODELS[tier] || COUNCIL_MODELS.balanced;

  // ===== НОВОЕ: Инициализируем PhaseTracker =====
  const phaseTracker = new PhaseTracker([
    'инициализация',
    'подготовка_моделей',
    'запрос_совета',
    'сбор_ответов',
    'агрегация'
  ]);
  const trk = multiAgentTasks.get(chatId);
  const councilId = `council_\${Date.now()}`;
  if (trk) {
    if (!phaseTrackers.has(chatId)) phaseTrackers.set(chatId, new Map());
    phaseTrackers.get(chatId).set(councilId, phaseTracker);
  }
  phaseTracker.startPhase('инициализация');`;

patchRegExp(cInitOld, cInitNew);

const cInitWait = /(if \(statusUpdater\) statusUpdater\('⚖️ Сбор Совета\.\.\. Ожидаем ответов от ' \+ availableModels\.length \+ ' моделей'\);)/;
const cInitWaitNew = `$1
  phaseTracker.completePhase('инициализация');
  phaseTracker.startPhase('подготовка_моделей');
  phaseTracker.completePhase('подготовка_моделей');
  phaseTracker.startPhase('запрос_совета');`;
patchRegExp(cInitWait, cInitWaitNew);

const cPromiseWait = /(const results = await Promise\.all\(promises\);)/;
const cPromiseWaitNew = `$1
  phaseTracker.completePhase('запрос_совета');
  phaseTracker.startPhase('сбор_ответов');
  phaseTracker.completePhase('сбор_ответов');
  phaseTracker.startPhase('агрегация');`;
patchRegExp(cPromiseWait, cPromiseWaitNew);

const cFin = /(if \(statusUpdater\) statusUpdater\('⚖️ Совет завершил работу\. Готовлю финальный ответ\.'\);)/;
const cFinNew = `$1
  phaseTracker.completePhase('агрегация');
  logTaskAction(chatId, 'Совет мудрецов', 'completed', Date.now() - startTime, 'council');`;
patchRegExp(cFin, cFinNew);

// Status command modification
// Instead of replacing the whole block, let's inject `resourceText` and `historyText` right before `await editText(chatId, msgId, `📊 Статус

``

const statusRenderOld = /await editText\(chatId, msgId,\s*`📊 Статус

` \+/;
const statusRenderNew = `
    const taskHist = getTaskHistory(chatId);
    const resourceMonitor = getResourceMonitor(chatId);
    const resourceStats = resourceMonitor.getStats();
    const recentHistory = taskHist.getRecent(3);

    let historyText = '';
    if (recentHistory.length > 0) {
      historyText = '
┌─ 📜 История (последние 3) ─
';
      for (const entry of recentHistory) {
        const time = new Date(entry.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const stIcon = entry.status === 'completed' ? '✅' : entry.status === 'error' ? '❌' : '⏳';
        historyText += `│ \${stIcon} \${time} \${entry.action}
`;
      }
      historyText += '└──────────────────
';
    }

    let resourceText = '';
    if (resourceStats) {
      resourceText = `
┌─ 💾 Ресурсы ─────────
` +
        `│ Память: \${resourceStats.heapUsed}/\${resourceStats.heapTotal}MB (\${resourceStats.percent}%) \${resourceStats.trend}
` +
        `└──────────────────
`;
    }

    await editText(chatId, msgId,
      `📊 Статус

` +
      (resourceText ? resourceText.substring(1) + '
' : '') +
      (historyText ? historyText.substring(1) + '
' : '') +`;
patchRegExp(statusRenderOld, statusRenderNew);


if (modified) {
  fs.writeFileSync(botPath, content, 'utf8');
  console.log('✅ bot.js updated successfully!');
} else {
  console.log('⚠️ No modifications were made.');
}
