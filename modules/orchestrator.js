'use strict';

/**
 * ORCHESTRATOR v1.0 — Meta-level task orchestrator
 *
 * Smart router that decides the best execution strategy for any task:
 * - Simple question → direct AI call
 * - Code task → delegate to specialist agent
 * - Complex project → create team + parallel execution
 * - Repeated pattern → execute existing skill
 * - Integration needed → auto-connect + execute
 *
 * Self-learning: tracks what works, improves routing over time.
 */

const crypto = require('crypto');

// Execution strategy types
const STRATEGY = {
  DIRECT_AI: 'direct_ai',          // Simple — one AI call
  SINGLE_AGENT: 'single_agent',    // Medium — one specialist agent
  MULTI_AGENT: 'multi_agent',      // Complex — team of agents
  SKILL_EXEC: 'skill_exec',        // Known pattern — execute skill
  AUTONOMOUS: 'autonomous',        // Very complex — full autonomous executor
  PIPELINE: 'pipeline',            // Sequential chain of operations
  INTEGRATION: 'integration',      // Requires external service
};

class Orchestrator {
  constructor({
    callAI, callAIWithFallback, runSubAgentLoop, executeAction,
    dynamicAgentCreator, skillManager, integrationHub,
    autonomousExecutor, superAgentFactory, globalPool,
    sendUpdate,
  }) {
    this.callAI = callAI;
    this.callAIWithFallback = callAIWithFallback;
    this.runSubAgentLoop = runSubAgentLoop;
    this.executeAction = executeAction;
    this.agentCreator = dynamicAgentCreator;
    this.skillManager = skillManager;
    this.integrationHub = integrationHub;
    this.autonomousExecutor = autonomousExecutor;
    this.superAgentFactory = superAgentFactory;
    this.globalPool = globalPool;
    this.sendUpdate = sendUpdate;

    // Routing history for self-learning
    this.routingHistory = [];
    this.strategyStats = {};
    for (const s of Object.values(STRATEGY)) this.strategyStats[s] = { count: 0, success: 0, avgDuration: 0 };
  }

  /**
   * Main entry point: analyze task and execute with optimal strategy
   */
  async execute(chatId, taskDescription, opts = {}) {
    const { onProgress, forceStrategy, context = {} } = opts;
    const taskId = `orch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const startTime = Date.now();

    const progress = (msg) => {
      if (onProgress) onProgress({ taskId, message: msg, timestamp: Date.now() });
      if (this.sendUpdate) this.sendUpdate(chatId, msg);
    };

    try {
      // 1. Analyze and select strategy
      const strategy = forceStrategy || await this._selectStrategy(chatId, taskDescription);
      progress(`[Orchestrator] Strategy: ${strategy.type} | ${strategy.reasoning}`);

      // 2. Check for existing skill
      if (strategy.type !== STRATEGY.SKILL_EXEC && this.skillManager) {
        const existingSkill = await this.skillManager.findSkillForTask(taskDescription, chatId);
        if (existingSkill && existingSkill.score > 0.7) {
          progress(`[Orchestrator] Found matching skill: ${existingSkill.skill.name}`);
          strategy.type = STRATEGY.SKILL_EXEC;
          strategy.skillId = existingSkill.id;
        }
      }

      // 3. Execute based on strategy
      let result;
      switch (strategy.type) {
        case STRATEGY.DIRECT_AI:
          result = await this._executeDirect(chatId, taskDescription, strategy, progress);
          break;
        case STRATEGY.SINGLE_AGENT:
          result = await this._executeSingleAgent(chatId, taskDescription, strategy, progress);
          break;
        case STRATEGY.MULTI_AGENT:
          result = await this._executeMultiAgent(chatId, taskDescription, strategy, progress);
          break;
        case STRATEGY.SKILL_EXEC:
          result = await this._executeSkill(chatId, taskDescription, strategy, progress);
          break;
        case STRATEGY.AUTONOMOUS:
          result = await this._executeAutonomous(chatId, taskDescription, strategy, progress);
          break;
        case STRATEGY.PIPELINE:
          result = await this._executePipeline(chatId, taskDescription, strategy, progress);
          break;
        case STRATEGY.INTEGRATION:
          result = await this._executeWithIntegration(chatId, taskDescription, strategy, progress);
          break;
        default:
          result = await this._executeDirect(chatId, taskDescription, strategy, progress);
      }

      const duration = Date.now() - startTime;
      const success = result?.success !== false;

      // 4. Self-learn
      this._recordResult(strategy.type, success, duration, taskDescription);

      // 5. Try to learn a skill from successful execution
      if (success && this.skillManager && strategy.type !== STRATEGY.DIRECT_AI && strategy.type !== STRATEGY.SKILL_EXEC) {
        const learnResult = await this.skillManager.learnFromExecution(
          taskDescription, strategy.steps || [], result?.output || '', { chatId }
        ).catch(() => ({ learned: false }));
        if (learnResult.learned) {
          progress(`[Orchestrator] New skill learned: ${learnResult.skill?.name || 'unknown'}`);
        }
      }

      return {
        taskId,
        success,
        strategy: strategy.type,
        output: result?.output || result?.text || result || '',
        duration,
        agentsUsed: strategy.agents || [],
        skillsUsed: strategy.skillId ? [strategy.skillId] : [],
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      this._recordResult(strategy?.type || 'direct', false, duration, taskDescription);
      return { taskId, success: false, error: e.message, duration };
    }
  }

  /**
   * AI-powered strategy selection
   */
  async _selectStrategy(chatId, taskDescription) {
    const tLow = taskDescription.toLowerCase();
    const len = taskDescription.length;

    // Quick heuristic pre-filter
    if (len < 100 && !/создай|построй|разработай|сделай проект|build|create|develop|implement|project/.test(tLow)) {
      if (/\?$|что |как |зачем|почему|when|what|how|why|explain|объясн/.test(tLow)) {
        return { type: STRATEGY.DIRECT_AI, reasoning: 'Simple question', model: 'gemini-2.5-flash' };
      }
    }

    // Check for integration keywords
    if (/api|webhook|интеграц|подключ|connect|send to|post to|отправ.*в|github|notion|sheets|email|smtp/.test(tLow)) {
      return { type: STRATEGY.INTEGRATION, reasoning: 'Integration detected' };
    }

    // For longer/complex tasks, use AI to decide
    const prompt = `Analyze this task and select the best execution strategy. Return ONLY valid JSON.

Task: "${taskDescription.slice(0, 500)}"

Strategies (pick one):
- direct_ai: Simple question, translation, short text. One AI call.
- single_agent: Medium task needing one specialist (coding, analysis, design).
- multi_agent: Complex task needing 2+ specialists working in parallel.
- autonomous: Very complex multi-step project with planning, execution, synthesis.
- pipeline: Sequential chain of operations (data processing, content pipeline).
- integration: Needs external API/service connection.
- skill_exec: Matches a known reusable pattern.

Return JSON:
{
  "type": "strategy_name",
  "reasoning": "brief why",
  "agents": ["role1", "role2"],
  "model": "preferred model for direct_ai",
  "estimatedSteps": 3,
  "complexity": "low|medium|high|extreme"
}`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Task strategy selector. Be precise. Reply ONLY with JSON.',
        chatId, { allowMcp: false }
      );
      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          type: parsed.type || STRATEGY.DIRECT_AI,
          reasoning: parsed.reasoning || '',
          agents: parsed.agents || [],
          model: parsed.model || 'gemini-2.5-flash',
          estimatedSteps: parsed.estimatedSteps || 1,
          complexity: parsed.complexity || 'medium',
        };
      }
    } catch (e) {
      console.error('[Orchestrator] Strategy selection error:', e.message);
    }

    // Fallback: use heuristic
    if (len > 300) return { type: STRATEGY.MULTI_AGENT, reasoning: 'Long description = complex task' };
    return { type: STRATEGY.SINGLE_AGENT, reasoning: 'Default fallback' };
  }

  async _executeDirect(chatId, task, strategy, progress) {
    progress('[Orchestrator] Direct AI call...');
    const result = await this.callAIWithFallback(
      strategy.model || 'gemini-2.5-flash',
      [{ role: 'user', content: task }],
      '', chatId
    );
    return { success: true, output: result?.text || '' };
  }

  async _executeSingleAgent(chatId, task, strategy, progress) {
    const role = (strategy.agents && strategy.agents[0]) || 'coder';
    progress(`[Orchestrator] Delegating to ${role}...`);

    // Check if we need a custom agent
    if (this.agentCreator) {
      const existing = this.agentCreator.findExistingAgent(task);
      if (existing.length === 0 || existing[0].score < 0.4) {
        progress('[Orchestrator] Creating custom agent...');
        const { agent } = await this.agentCreator.createAgent(task, { chatId });
        const output = await this.runSubAgentLoop(chatId, task, agent.id, agent.systemPrompt || '', agent.maxSteps || 7);
        this.agentCreator.updateAgentStats(agent.id, !!output);
        return { success: !!output, output: output || '' };
      }
    }

    const output = await this.runSubAgentLoop(chatId, task, role, '', 10);
    return { success: !!output, output: output || '' };
  }

  async _executeMultiAgent(chatId, task, strategy, progress) {
    progress('[Orchestrator] Creating agent team...');

    if (this.agentCreator) {
      const teamPlan = await this.agentCreator.createTeamForTask(task, { chatId });
      if (teamPlan.team.length > 0) {
        progress(`[Orchestrator] Team: ${teamPlan.team.map(m => m.role).join(', ')} | Strategy: ${teamPlan.strategy}`);

        // Execute team tasks via globalPool
        const results = [];
        const teamTasks = teamPlan.team.map((member, idx) => ({
          id: `team_${idx}_${member.role}`,
          fn: async () => {
            progress(`[Agent ${member.role}] Starting: ${member.task?.slice(0, 80) || '...'}`);
            const output = await this.runSubAgentLoop(chatId, member.task || task, member.role, '', 7);
            if (this.agentCreator && member.agent?.type === 'custom') {
              this.agentCreator.updateAgentStats(member.role, !!output);
            }
            return output;
          },
          meta: { role: member.role, priority: member.priority || 'medium' },
        }));

        // Submit to pool
        const promises = teamTasks.map(t => this.globalPool.submit(t.id, t.fn, t.meta));
        const poolResults = await Promise.allSettled(promises);

        const outputs = poolResults.map((r, i) => {
          const role = teamTasks[i].meta.role;
          if (r.status === 'fulfilled') return `## ${role}\n${r.value || '(no output)'}`;
          return `## ${role}\nError: ${r.reason?.message || 'unknown'}`;
        });

        // Synthesize
        progress('[Orchestrator] Synthesizing results...');
        const synthResult = await this.callAIWithFallback(
          'gemini-2.5-flash',
          [{ role: 'user', content: `Synthesize these agent results into a coherent final report:\n\n${outputs.join('\n\n---\n\n')}\n\nOriginal task: ${task}` }],
          'Synthesizer. Combine multi-agent results into a clear, actionable report in Russian.',
          chatId, { allowMcp: false }
        );

        return { success: true, output: synthResult?.text || outputs.join('\n\n') };
      }
    }

    // Fallback to superAgentFactory
    if (this.superAgentFactory) {
      const result = await this.superAgentFactory.createAndExecuteTeam(chatId, task);
      return { success: result?.success, output: result?.result?.output || '' };
    }

    return this._executeSingleAgent(chatId, task, strategy, progress);
  }

  async _executeSkill(chatId, task, strategy, progress) {
    const skillId = strategy.skillId;
    if (!skillId || !this.skillManager) {
      return this._executeSingleAgent(chatId, task, strategy, progress);
    }

    progress(`[Orchestrator] Executing skill: ${skillId}`);
    const result = await this.skillManager.executeSkill(skillId, { task }, {
      chatId,
      onProgress: (p) => progress(`[Skill ${skillId}] Step ${p.step}/${p.total}: ${p.desc}`),
    });
    return result;
  }

  async _executeAutonomous(chatId, task, strategy, progress) {
    progress('[Orchestrator] Launching autonomous execution...');
    if (this.autonomousExecutor) {
      const result = await this.autonomousExecutor.execute(chatId, task, {
        onProgress: (u) => progress(u.message),
      });
      return result;
    }
    return this._executeMultiAgent(chatId, task, strategy, progress);
  }

  async _executePipeline(chatId, task, strategy, progress) {
    progress('[Orchestrator] Building pipeline...');

    const prompt = `Break this task into a sequential pipeline of 3-7 steps. Return ONLY JSON.

Task: ${task}

Return: {"steps": [{"action": "ai_call|delegate|bash|search|web_fetch", "role": "agent_role", "task": "step description", "params": {}}]}`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Pipeline builder. JSON only.',
        chatId, { allowMcp: false }
      );
      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');

      const pipeline = JSON.parse(jsonMatch[0]);
      const outputs = [];

      for (let i = 0; i < (pipeline.steps || []).length; i++) {
        const step = pipeline.steps[i];
        const prevOutput = outputs.length > 0 ? outputs[outputs.length - 1] : '';
        progress(`[Pipeline ${i + 1}/${pipeline.steps.length}] ${step.task?.slice(0, 60) || step.action}`);

        const stepTask = `${step.task || ''}\n\nContext from previous step:\n${String(prevOutput).slice(0, 1000)}`;

        if (step.action === 'delegate' && step.role) {
          const output = await this.runSubAgentLoop(chatId, stepTask, step.role, '', 7);
          outputs.push(output || '');
        } else if (step.action === 'ai_call') {
          const aiResult = await this.callAIWithFallback(
            'gemini-2.5-flash', [{ role: 'user', content: stepTask }], '', chatId, { allowMcp: false }
          );
          outputs.push(aiResult?.text || '');
        } else if (this.executeAction) {
          const actionResult = await this.executeAction(chatId, { name: step.action, body: step.task || '' });
          outputs.push(actionResult?.output || actionResult?.text || '');
        }
      }

      strategy.steps = pipeline.steps;
      return { success: true, output: outputs[outputs.length - 1] || outputs.join('\n\n') };
    } catch (e) {
      return this._executeSingleAgent(chatId, task, strategy, progress);
    }
  }

  async _executeWithIntegration(chatId, task, strategy, progress) {
    progress('[Orchestrator] Checking integrations...');

    if (this.integrationHub) {
      const suggestions = await this.integrationHub.suggestIntegrations(task, chatId);

      // Use existing integrations first
      if (suggestions.existingUseful?.length > 0) {
        const intId = suggestions.existingUseful[0];
        const int = this.integrationHub.getIntegration(intId);
        if (int) {
          progress(`[Orchestrator] Using integration: ${int.name}`);
          const result = await this.integrationHub.executeIntegration(intId, 'default', { task }, { chatId });
          if (result.success) return result;
        }
      }

      // Suggest new integrations
      if (suggestions.suggestions?.length > 0) {
        const suggestion = suggestions.suggestions[0];
        progress(`[Orchestrator] Suggested integration: ${suggestion.name} (${suggestion.type})`);
      }
    }

    // Fallback to agent execution
    return this._executeSingleAgent(chatId, task, strategy, progress);
  }

  _recordResult(strategyType, success, duration, task) {
    const stats = this.strategyStats[strategyType];
    if (stats) {
      stats.count++;
      if (success) stats.success++;
      stats.avgDuration = Math.round((stats.avgDuration * (stats.count - 1) + duration) / stats.count);
    }
    this.routingHistory.push({
      strategy: strategyType, success, duration,
      task: task.slice(0, 100), timestamp: Date.now(),
    });
    if (this.routingHistory.length > 200) this.routingHistory = this.routingHistory.slice(-100);
  }

  /**
   * Get orchestrator statistics
   */
  getStats() {
    return {
      strategies: { ...this.strategyStats },
      totalTasks: this.routingHistory.length,
      successRate: this.routingHistory.length > 0
        ? (this.routingHistory.filter(r => r.success).length / this.routingHistory.length * 100).toFixed(1) + '%'
        : 'N/A',
      recentTasks: this.routingHistory.slice(-5),
    };
  }
}

module.exports = { Orchestrator, STRATEGY };
