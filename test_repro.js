
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Mock dependencies
const userConfigs = new Map();
const chatHistory = new Map();
const adminIds = [];
const defaultUserConfig = { model: 'claude-haiku', agentMode: true };
const AGENT_SYSTEM_PROMPT = 'agent';
const BOT_SYSTEM_PROMPT = 'bot';
const PROVIDER_LABELS = { google: 'Google' };

function getUserConfig(id) { return userConfigs.get(id) || defaultUserConfig; }
function getProvider(m) { return 'google'; }
function rewriteQuery(id, t) { return { text: t, rewritten: false }; }
function autoSelectModel(t) { return { model: 'gemini-3-flash-preview', reason: 'test' }; }
function getGeminiKey() { return 'key'; }
function estimateComplexity() { return { complexity: 'simple', maxSteps: 5 }; }
function addToHistory() {}
function getQueueSize() { return 0; }
async function send() { return { result: { message_id: 123 } }; }

const activeTasks = new Map();
let activeClaudeCount = 0;
const MAX_CLAUDE_PROCS = 3;

async function runClaude(chatId, text) {
  const uc = getUserConfig(chatId);
  let model = uc.model;
  let prompt = text;

  const queryRewrite = rewriteQuery(chatId, prompt);
  if (queryRewrite.rewritten) {
    prompt = queryRewrite.text;
  }

  const auto = autoSelectModel(prompt);
  model = auto.model;

  if (activeClaudeCount >= MAX_CLAUDE_PROCS) return;
  activeClaudeCount++;

  const agentEnabled = uc.agentMode !== false;
  const multiAgentEnabled = false;
  const estimated = estimateComplexity(prompt, agentEnabled, multiAgentEnabled, chatId);

  addToHistory(chatId, 'user', prompt);

  const history = chatHistory.get(chatId) || [];
  const complexity = estimated.complexity || 'medium';
  
  console.log('Complexity:', complexity);
  
  const res = await send(chatId, 'status');
  const statusMsgId = res?.result?.message_id;
  
  console.log('Status message sent:', statusMsgId);
  console.log('DONE');
}

runClaude(123, '?').then(() => console.log('Finished successfully')).catch(e => console.error('CRASH:', e));
