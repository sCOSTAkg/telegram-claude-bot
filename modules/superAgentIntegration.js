'use strict';

/**
 * SUPER-AGENT FACTORY INTEGRATION v2.0
 *
 * Подключение системы супагентов к bot.js
 * Теперь использует parallelEngine для реального параллельного выполнения
 */

const SuperAgentFactory = require('./superAgentFactory');
const SuperAgentCommands = require('./superAgentCommands');
const { BUSINESS_DOMAINS, detectDomain } = require('./parallelEngine');

let superAgentFactory = null;
let superAgentCommands = null;

/**
 * Инициализировать систему супагентов
 *
 * @param {Telegraf} bot - Инстанс бота
 * @param {object} options - { usersFile, callAI, runSubAgentLoop, getEffectiveAgents }
 */
function initSuperAgentSystem(bot, options = {}) {
  superAgentFactory = new SuperAgentFactory({
    usersFile: options.usersFile || './users.json',
    dataDir: options.dataDir || './data',
    maxConcurrent: options.maxConcurrent || 3,
    callAI: options.callAI || null,
    runSubAgentLoop: options.runSubAgentLoop || null,
    getEffectiveAgents: options.getEffectiveAgents || null,
  });

  superAgentCommands = new SuperAgentCommands(bot, superAgentFactory);

  console.log('[SuperAgentFactory] v2.0 initialized');
  console.log('[SuperAgentFactory] Commands: /team, /agents, /skills, /team-status, /task-history');
  console.log(`[SuperAgentFactory] Domains: ${Object.keys(BUSINESS_DOMAINS).join(', ')}`);

  return superAgentFactory;
}

function getFactory() {
  if (!superAgentFactory) {
    throw new Error('SuperAgentFactory not initialized. Call initSuperAgentSystem() first.');
  }
  return superAgentFactory;
}

async function createTeamProgrammatically(userId, taskDescription, options = {}) {
  return getFactory().createAndExecuteTeam(userId, taskDescription, options);
}

async function reuseSavedAgentsProgrammatically(userId, newTask, roles = []) {
  return getFactory().reuseSavedAgents(userId, newTask, roles);
}

async function getUserAgents(userId) {
  return getFactory().loadUserAgents(userId);
}

async function getUserStats(userId) {
  try {
    const fs = require('fs');
    const usersData = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
    const userData = usersData[userId];
    if (!userData) return null;

    return {
      agentsCount: userData.superAgents?.length || 0,
      skillsCount: userData.generatedSkills?.length || 0,
      tasksCompleted: userData.taskHistory?.length || 0,
      lastTaskDate: userData.taskHistory?.[userData.taskHistory.length - 1]?.timestamp || null,
      domains: [...new Set((userData.taskHistory || []).map(t => t.domain).filter(Boolean))],
    };
  } catch (err) {
    return null;
  }
}

/**
 * Обнаружить домен задачи
 */
function detectTaskDomain(text) {
  return detectDomain(text);
}

/**
 * Получить информацию о домене
 */
function getDomainInfo(domain) {
  return BUSINESS_DOMAINS[domain] || null;
}

module.exports = {
  initSuperAgentSystem,
  getFactory,
  createTeamProgrammatically,
  reuseSavedAgentsProgrammatically,
  getUserAgents,
  getUserStats,
  detectTaskDomain,
  getDomainInfo,
  BUSINESS_DOMAINS,
};
