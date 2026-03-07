'use strict';

/**
 * DYNAMIC AGENT CREATOR v1.0
 *
 * Autonomously creates new agents on-the-fly when existing roles are insufficient.
 * AI analyzes the task and generates agent definition with custom prompt, tools, model.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AGENT_ROLES, PRESET_AGENTS } = require('../config/agents');

const CUSTOM_AGENTS_FILE = path.join(__dirname, '..', 'data', 'custom_agents.json');

class DynamicAgentCreator {
  constructor({ callAI, callAIWithFallback }) {
    this.callAI = callAI;
    this.callAIWithFallback = callAIWithFallback;
    this.customAgents = new Map();
    this._loadCustomAgents();
  }

  _loadCustomAgents() {
    try {
      if (fs.existsSync(CUSTOM_AGENTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(CUSTOM_AGENTS_FILE, 'utf8'));
        for (const [id, agent] of Object.entries(data)) {
          this.customAgents.set(id, agent);
        }
      }
    } catch (e) {
      console.error('[DynamicAgentCreator] Load error:', e.message);
    }
  }

  _saveCustomAgents() {
    try {
      const dir = path.dirname(CUSTOM_AGENTS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CUSTOM_AGENTS_FILE, JSON.stringify(Object.fromEntries(this.customAgents), null, 2));
    } catch (e) {
      console.error('[DynamicAgentCreator] Save error:', e.message);
    }
  }

  findExistingAgent(taskDescription) {
    const tLow = taskDescription.toLowerCase();
    const matches = [];
    for (const [roleId, role] of Object.entries(AGENT_ROLES)) {
      const score = this._matchScore(tLow, `${role.label} ${role.desc}`.toLowerCase());
      if (score > 0.3) matches.push({ id: roleId, type: 'preset', score, ...role });
    }
    for (const [id, agent] of this.customAgents) {
      const score = this._matchScore(tLow, `${agent.label} ${agent.desc} ${agent.expertise || ''}`.toLowerCase());
      if (score > 0.3) matches.push({ id, type: 'custom', score, ...agent });
    }
    return matches.sort((a, b) => b.score - a.score);
  }

  _matchScore(query, target) {
    const words = query.split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return 0;
    return words.filter(w => target.includes(w)).length / words.length;
  }

  async createAgent(taskDescription, opts = {}) {
    const { chatId = 'system', domain = null, forceCreate = false } = opts;

    if (!forceCreate) {
      const existing = this.findExistingAgent(taskDescription);
      if (existing.length > 0 && existing[0].score > 0.6) {
        return { created: false, agent: existing[0], reason: 'found_existing' };
      }
    }

    const prompt = `Create a specialized AI agent definition for this task. Return ONLY valid JSON.

Task: ${taskDescription}
${domain ? `Domain: ${domain}` : ''}

Required JSON format:
{
  "id": "snake_case_agent_id",
  "icon": "single emoji",
  "label": "Agent Name (2-4 words)",
  "desc": "One-line description of specialization",
  "expertise": "comma-separated list of skills and knowledge areas",
  "tools": ["list", "of", "tool", "names"],
  "systemPrompt": "Detailed system prompt in Russian. Include: role description, key principles, methodology, tech stack, output format. 200-400 words.",
  "maxSteps": 10,
  "model": "gemini-2.5-flash",
  "category": "dev|data|business|creative|specialized|media|automation"
}

Tools available: bash, search, web_fetch, read_file, write_file, edit_file, image, video, http_request, delegate, ai_call, mcp`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'You are an agent architect. Create precise, effective agent definitions. Reply ONLY with valid JSON.',
        chatId, { allowMcp: false }
      );

      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');

      const agentDef = JSON.parse(jsonMatch[0]);
      const agent = {
        id: agentDef.id || `custom_${crypto.randomBytes(4).toString('hex')}`,
        icon: agentDef.icon || '',
        label: agentDef.label || 'Custom Agent',
        desc: agentDef.desc || taskDescription.slice(0, 100),
        expertise: agentDef.expertise || '',
        tools: Array.isArray(agentDef.tools) ? agentDef.tools : ['ai_call', 'delegate'],
        systemPrompt: agentDef.systemPrompt || '',
        maxSteps: agentDef.maxSteps || 10,
        model: agentDef.model || 'gemini-2.5-flash',
        category: agentDef.category || 'specialized',
        createdAt: new Date().toISOString(),
        createdFor: taskDescription.slice(0, 200),
        usageCount: 0,
        successRate: 1.0,
      };

      this.customAgents.set(agent.id, agent);
      this._saveCustomAgents();
      console.log(`[DynamicAgentCreator] Created: ${agent.id} (${agent.label})`);
      return { created: true, agent, reason: 'created_new' };
    } catch (e) {
      console.error('[DynamicAgentCreator] Create error:', e.message);
      const fallback = {
        id: `custom_${crypto.randomBytes(4).toString('hex')}`,
        icon: '', label: 'Task Specialist',
        desc: taskDescription.slice(0, 100),
        expertise: taskDescription,
        tools: ['ai_call', 'delegate', 'bash', 'search', 'web_fetch'],
        systemPrompt: `Ty -- specializirovannyj agent. Tvoya zadacha: ${taskDescription}. Rabotaj effektivno.`,
        maxSteps: 10, model: 'gemini-2.5-flash', category: 'specialized',
        createdAt: new Date().toISOString(),
        createdFor: taskDescription.slice(0, 200),
        usageCount: 0, successRate: 1.0,
      };
      this.customAgents.set(fallback.id, fallback);
      this._saveCustomAgents();
      return { created: true, agent: fallback, reason: 'fallback_created' };
    }
  }

  async createTeamForTask(taskDescription, opts = {}) {
    const { chatId = 'system', maxAgents = 5 } = opts;

    const prompt = `Analyze this task and create a team of specialized agents. Return ONLY valid JSON.

Task: ${taskDescription}
Existing agents: ${Object.keys(AGENT_ROLES).slice(0, 30).join(', ')}
Custom agents: ${[...this.customAgents.keys()].join(', ') || 'none'}

Return JSON:
{
  "team": [
    {"role": "existing_role_id OR create_new", "task": "specific subtask", "priority": "high|medium|low", "deps": [], "newAgentSpec": null}
  ],
  "strategy": "parallel|sequential|mixed",
  "reasoning": "brief explanation"
}
If role="create_new", include newAgentSpec: {"label":"Name","desc":"...","expertise":"..."}
Maximum ${maxAgents} agents.`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'You are a team architect. Design optimal agent teams. Reply ONLY with valid JSON.',
        chatId, { allowMcp: false }
      );
      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');

      const teamPlan = JSON.parse(jsonMatch[0]);
      const resolvedTeam = [];

      for (const member of (teamPlan.team || [])) {
        if (member.role === 'create_new' && member.newAgentSpec) {
          const { agent } = await this.createAgent(member.task, { chatId });
          resolvedTeam.push({ ...member, role: agent.id, agent });
        } else {
          const agentDef = AGENT_ROLES[member.role] || this.customAgents.get(member.role);
          resolvedTeam.push({ ...member, agent: agentDef || { id: member.role, label: member.role } });
        }
      }

      return { team: resolvedTeam, strategy: teamPlan.strategy || 'mixed', reasoning: teamPlan.reasoning || '' };
    } catch (e) {
      console.error('[DynamicAgentCreator] Team error:', e.message);
      return { team: [], strategy: 'sequential', reasoning: 'Error: ' + e.message };
    }
  }

  updateAgentStats(agentId, success) {
    const agent = this.customAgents.get(agentId);
    if (!agent) return;
    agent.usageCount = (agent.usageCount || 0) + 1;
    const oldRate = agent.successRate || 1.0;
    agent.successRate = (oldRate * (agent.usageCount - 1) + (success ? 1 : 0)) / agent.usageCount;
    this.customAgents.set(agentId, agent);
    this._saveCustomAgents();
  }

  pruneAgents(minSuccessRate = 0.3, minUsage = 3) {
    const pruned = [];
    for (const [id, agent] of this.customAgents) {
      if (agent.usageCount >= minUsage && agent.successRate < minSuccessRate) {
        this.customAgents.delete(id);
        pruned.push(id);
      }
    }
    if (pruned.length > 0) this._saveCustomAgents();
    return pruned;
  }

  getAllAgents() {
    const all = {};
    for (const [id, role] of Object.entries(AGENT_ROLES)) all[id] = { ...role, type: 'preset' };
    for (const [id, agent] of this.customAgents) all[id] = { ...agent, type: 'custom' };
    return all;
  }

  getCustomAgents() { return Object.fromEntries(this.customAgents); }

  getAgent(id) {
    return AGENT_ROLES[id] || PRESET_AGENTS[id] || this.customAgents.get(id) || null;
  }

  deleteAgent(id) {
    if (this.customAgents.has(id)) {
      this.customAgents.delete(id);
      this._saveCustomAgents();
      return true;
    }
    return false;
  }
}

module.exports = { DynamicAgentCreator };
