'use strict';

/**
 * SUPER-AGENT FACTORY v2.0
 *
 * Реальная система создания команд супагентов.
 * Интегрирована с parallelEngine для параллельного выполнения.
 *
 * CHANGES v2:
 * - Реальный AI-анализ задач (через callAI callback)
 * - Интеграция с parallelEngine (ConcurrencyPool, autoDelegate)
 * - Domain-aware agent creation
 * - Auto skill generation from successful tasks
 * - Streaming progress
 */

const fs = require('fs').promises;
const { detectDomain, detectRolesForTask, BUSINESS_DOMAINS, autoDelegate, shouldGenerateSkill, generateSkillDefinition, ConcurrencyPool } = require('./parallelEngine');

class SuperAgentFactory {
  constructor(config = {}) {
    this.config = {
      dataDir: config.dataDir || './data',
      usersFile: config.usersFile || './users.json',
      ...config
    };

    this.agentRegistry = new Map();
    this.skillRegistry = new Map();
    this.taskHistory = [];
    this.pool = new ConcurrencyPool(config.maxConcurrent || 3);

    // Callbacks for integration with bot.js
    this.callAI = config.callAI || null;           // async (model, messages, system, chatId, opts) => result
    this.runSubAgentLoop = config.runSubAgentLoop || null; // async (chatId, task, role, ctx, steps) => result
    this.getEffectiveAgents = config.getEffectiveAgents || null;
  }

  /**
   * Анализ задачи с реальным AI (или fallback на эвристику)
   */
  async analyzeTask(taskDescription, context = {}) {
    const domain = detectDomain(taskDescription);
    const roles = detectRolesForTask(taskDescription, domain);
    const domainConfig = domain ? BUSINESS_DOMAINS[domain] : null;

    // Определяем сложность по длине + кол-ву ролей
    let complexity = 'medium';
    if (roles.length >= 4 || taskDescription.length > 500) complexity = 'high';
    else if (roles.length <= 1 && taskDescription.length < 100) complexity = 'low';

    // Если есть AI — пробуем более точный анализ
    if (this.callAI && complexity !== 'low') {
      try {
        const analysisPrompt = `Analyze this task and return JSON:
Task: ${taskDescription}
Detected domain: ${domainConfig?.label || 'general'}
Suggested roles: ${roles.join(', ')}

Return JSON ONLY:
{"agents":["role1","role2"],"skillsNeeded":["skill-name"],"complexity":"low|medium|high","timeline":"quick|balanced|thorough","reasoning":"brief why"}`;

        const result = await this.callAI('gemini-2.5-flash',
          [{ role: 'user', content: analysisPrompt }],
          'Task analysis engine. Reply ONLY with valid JSON.',
          context.chatId || 'system',
          { allowMcp: false }
        );

        const text = (result?.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            agents: parsed.agents || roles,
            requiredDocs: [],
            skillsNeeded: parsed.skillsNeeded || [],
            complexity: parsed.complexity || complexity,
            timeline: parsed.timeline || 'balanced',
            reasoning: parsed.reasoning || '',
            domain,
            domainLabel: domainConfig?.label,
          };
        }
      } catch (e) {
        console.log(`[SuperAgentFactory] AI analysis failed, using heuristic: ${e.message}`);
      }
    }

    // Эвристический fallback
    return {
      agents: roles.length > 0 ? roles : ['executor'],
      requiredDocs: [],
      skillsNeeded: domainConfig?.skillTemplates?.slice(0, 2) || [],
      complexity,
      timeline: complexity === 'high' ? 'thorough' : 'balanced',
      reasoning: `Domain: ${domainConfig?.label || 'general'}, ${roles.length} roles detected`,
      domain,
      domainLabel: domainConfig?.label,
    };
  }

  /**
   * Создать и выполнить команду — главный метод
   */
  async createAndExecuteTeam(userId, taskDescription, options = {}) {
    const startTime = Date.now();
    const chatId = options.chatId || userId;

    try {
      // 1. Анализ
      const analysis = await this.analyzeTask(taskDescription, { chatId });
      console.log(`[SuperAgentFactory] Analysis: ${analysis.agents.join(', ')} | domain: ${analysis.domain || 'general'} | complexity: ${analysis.complexity}`);

      // 2. Выполнение через autoDelegate (параллельно)
      if (!this.runSubAgentLoop) {
        return { success: false, error: 'runSubAgentLoop not configured' };
      }

      const result = await autoDelegate(chatId, taskDescription, {
        runSubAgentLoop: this.runSubAgentLoop,
        getEffectiveAgents: this.getEffectiveAgents,
        callAI: this.callAI,
        pool: this.pool,
      });

      // 3. Авто-генерация скиллов
      const generatedSkills = [];
      if (result.success && result.subtasks) {
        for (const st of result.subtasks) {
          if (st.result?.success && shouldGenerateSkill(st.task, st.result.output, st.result.actions)) {
            const skillDef = generateSkillDefinition(st.task, st.role, st.result.actions, st.result.output);
            this.skillRegistry.set(skillDef.name, skillDef);
            generatedSkills.push(skillDef);
          }
        }
      }

      // 4. Сохранение в память
      const agents = analysis.agents.map(role => ({
        id: `agent-${role}-${Date.now().toString(36)}`,
        role,
        created: new Date().toISOString(),
        status: 'active',
        config: { specialization: role },
      }));

      await this.saveToUserMemory(userId, agents, generatedSkills, {
        task: taskDescription,
        complexity: analysis.complexity,
        domain: analysis.domain,
        duration: Date.now() - startTime,
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: result.success,
        result: {
          output: result.output,
          quality: result.success ? 85 : 30,
          domain: analysis.domain,
          domainLabel: analysis.domainLabel,
        },
        team: {
          agents: agents.map(a => ({ id: a.id, role: a.role })),
          skills: generatedSkills.map(s => s.name),
        },
        message: `Команда из ${agents.length} агентов (${analysis.domainLabel || 'general'}) выполнила задачу за ${duration}с. ${generatedSkills.length > 0 ? `Создано ${generatedSkills.length} новых скиллов.` : ''}`,
      };
    } catch (err) {
      console.error('[SuperAgentFactory] Error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Сохранить в users.json
   */
  async saveToUserMemory(userId, agents, skills, taskMetadata = {}) {
    try {
      let usersData = {};
      try {
        usersData = JSON.parse(await fs.readFile(this.config.usersFile, 'utf8'));
      } catch (e) { /* file not found, start fresh */ }

      if (!usersData[userId]) usersData[userId] = {};
      if (!usersData[userId].superAgents) usersData[userId].superAgents = [];
      if (!usersData[userId].generatedSkills) usersData[userId].generatedSkills = [];
      if (!usersData[userId].taskHistory) usersData[userId].taskHistory = [];

      // Upsert agents
      for (const agent of agents) {
        const idx = usersData[userId].superAgents.findIndex(a => a.role === agent.role);
        if (idx >= 0) usersData[userId].superAgents[idx] = agent;
        else usersData[userId].superAgents.push(agent);
      }

      // Add skills (no dupes)
      for (const skill of skills) {
        if (!usersData[userId].generatedSkills.some(s => s.name === skill.name)) {
          usersData[userId].generatedSkills.push({
            name: skill.name,
            baseRole: skill.role || skill.baseRole,
            created: skill.generatedAt || new Date().toISOString(),
            desc: skill.desc,
          });
        }
      }

      // Task history (last 50)
      usersData[userId].taskHistory.push({
        timestamp: new Date().toISOString(),
        ...taskMetadata,
        agentsUsed: agents.map(a => a.role),
        skillsGenerated: skills.map(s => s.name),
      });
      if (usersData[userId].taskHistory.length > 50) {
        usersData[userId].taskHistory = usersData[userId].taskHistory.slice(-50);
      }

      await fs.writeFile(this.config.usersFile, JSON.stringify(usersData, null, 2));
      return true;
    } catch (err) {
      console.error('[SuperAgentFactory] Save error:', err.message);
      return false;
    }
  }

  /**
   * Загрузить агентов пользователя
   */
  async loadUserAgents(userId) {
    try {
      const usersData = JSON.parse(await fs.readFile(this.config.usersFile, 'utf8'));
      return usersData[userId]?.superAgents || [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Переиспользовать сохранённых агентов
   */
  async reuseSavedAgents(userId, newTask, selectedRoles = []) {
    const savedAgents = await this.loadUserAgents(userId);
    if (savedAgents.length === 0) {
      return this.createAndExecuteTeam(userId, newTask);
    }

    const agentsToUse = selectedRoles.length > 0
      ? savedAgents.filter(a => selectedRoles.includes(a.role))
      : savedAgents;

    // Выполняем с сохранёнными ролями
    if (this.runSubAgentLoop) {
      const chatId = userId;
      const result = await autoDelegate(chatId, newTask, {
        runSubAgentLoop: this.runSubAgentLoop,
        getEffectiveAgents: this.getEffectiveAgents,
        callAI: this.callAI,
        pool: this.pool,
      });

      return { success: result.success, result, reusedCount: agentsToUse.length };
    }

    return { success: false, error: 'runSubAgentLoop not configured' };
  }
}

module.exports = SuperAgentFactory;
