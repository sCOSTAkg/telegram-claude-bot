'use strict';

/**
 * SKILL MANAGER v1.0
 *
 * Full lifecycle management for dynamically created skills:
 * - Create skills from successful task executions
 * - Store, search, compose, and execute skills
 * - Auto-learn: repeated patterns become reusable skills
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const SKILLS_INDEX_FILE = path.join(__dirname, '..', 'data', 'skills_index.json');

class SkillManager {
  constructor({ callAI, callAIWithFallback, executeAction, runSubAgentLoop }) {
    this.callAI = callAI;
    this.callAIWithFallback = callAIWithFallback;
    this.executeAction = executeAction;
    this.runSubAgentLoop = runSubAgentLoop;
    this.skills = new Map();
    this.executionLog = [];
    this._loadIndex();
  }

  _loadIndex() {
    try {
      if (fs.existsSync(SKILLS_INDEX_FILE)) {
        const data = JSON.parse(fs.readFileSync(SKILLS_INDEX_FILE, 'utf8'));
        for (const [id, skill] of Object.entries(data)) this.skills.set(id, skill);
      }
      // Also load .js skill files from skills/ directory
      if (fs.existsSync(SKILLS_DIR)) {
        for (const file of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.js'))) {
          try {
            const skillModule = require(path.join(SKILLS_DIR, file));
            if (skillModule.meta) {
              const id = skillModule.meta.id || file.replace('.js', '');
              if (!this.skills.has(id)) {
                this.skills.set(id, { ...skillModule.meta, type: 'file', file, loaded: true });
              }
            }
          } catch (e) { console.warn(`[SkillManager] Failed to load skill ${file}: ${e.message}`); }
        }
      }
    } catch (e) {
      console.error('[SkillManager] Load error:', e.message);
    }
  }

  _saveIndex() {
    try {
      const dir = path.dirname(SKILLS_INDEX_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SKILLS_INDEX_FILE, JSON.stringify(Object.fromEntries(this.skills), null, 2));
    } catch (e) {
      console.error('[SkillManager] Save error:', e.message);
    }
  }

  /**
   * Create a new skill from AI analysis of a task description
   */
  async createSkill(name, description, opts = {}) {
    const { chatId = 'system', steps = null, tags = [], category = 'general' } = opts;

    const prompt = `Create a reusable skill definition. Return ONLY valid JSON.

Skill name: ${name}
Description: ${description}
${steps ? `Suggested steps: ${JSON.stringify(steps)}` : ''}

Return JSON:
{
  "id": "snake_case_skill_id",
  "name": "${name}",
  "desc": "Clear one-line description",
  "category": "${category}",
  "tags": ${JSON.stringify(tags.length ? tags : ['auto'])},
  "inputSchema": {"param1": "description of param1", "param2": "description of param2"},
  "steps": [
    {"action": "tool_name", "params": {"key": "value or {{param1}} template"}, "desc": "What this step does"},
    {"action": "ai_call", "params": {"prompt": "template with {{param1}}"}, "desc": "AI analysis step"},
    {"action": "delegate", "params": {"role": "coder", "task": "template {{param1}}"}, "desc": "Delegate to agent"}
  ],
  "outputFormat": "text|json|file|mixed",
  "estimatedTime": "fast|medium|slow",
  "requiredTools": ["bash", "ai_call"]
}

Available actions: bash, search, web_fetch, read_file, write_file, edit_file, image, video, http_request, delegate, ai_call, mcp`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Skill architect. Create precise reusable skill definitions. Reply ONLY with valid JSON.',
        chatId, { allowMcp: false }
      );
      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');

      const skillDef = JSON.parse(jsonMatch[0]);
      const skill = {
        id: skillDef.id || `skill_${crypto.randomBytes(4).toString('hex')}`,
        name: skillDef.name || name,
        desc: skillDef.desc || description,
        category: skillDef.category || category,
        tags: skillDef.tags || tags,
        inputSchema: skillDef.inputSchema || {},
        steps: skillDef.steps || [],
        outputFormat: skillDef.outputFormat || 'text',
        estimatedTime: skillDef.estimatedTime || 'medium',
        requiredTools: skillDef.requiredTools || ['ai_call'],
        type: 'dynamic',
        createdAt: new Date().toISOString(),
        usageCount: 0,
        avgDuration: 0,
        successRate: 1.0,
      };

      this.skills.set(skill.id, skill);
      this._saveIndex();
      console.log(`[SkillManager] Created: ${skill.id} (${skill.name})`);
      return { success: true, skill };
    } catch (e) {
      console.error('[SkillManager] Create error:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Create skill from a successful task execution (auto-learn)
   */
  async learnFromExecution(taskDescription, executionSteps, result, opts = {}) {
    const { chatId = 'system' } = opts;

    const prompt = `A task was successfully completed. Extract a reusable skill from it. Return ONLY valid JSON.

Task: ${taskDescription}
Steps taken: ${JSON.stringify(executionSteps).slice(0, 2000)}
Result summary: ${String(result).slice(0, 500)}

Return JSON:
{
  "shouldCreateSkill": true/false,
  "skill": {
    "id": "snake_case",
    "name": "Skill Name",
    "desc": "What this skill does",
    "category": "dev|data|business|creative|automation",
    "tags": ["tag1", "tag2"],
    "inputSchema": {"param1": "desc"},
    "steps": [{"action": "tool", "params": {}, "desc": "step desc"}],
    "outputFormat": "text",
    "estimatedTime": "fast|medium|slow"
  },
  "reason": "why this should/shouldn't be a skill"
}`;

    try {
      const aiResult = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Skill extraction engine. Identify reusable patterns. Reply ONLY with valid JSON.',
        chatId, { allowMcp: false }
      );
      const text = (aiResult?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { learned: false, reason: 'no json' };

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.shouldCreateSkill || !parsed.skill) {
        return { learned: false, reason: parsed.reason || 'not suitable' };
      }

      const skill = {
        ...parsed.skill,
        id: parsed.skill.id || `learned_${crypto.randomBytes(4).toString('hex')}`,
        type: 'learned',
        createdAt: new Date().toISOString(),
        learnedFrom: taskDescription.slice(0, 200),
        usageCount: 0, avgDuration: 0, successRate: 1.0,
      };

      this.skills.set(skill.id, skill);
      this._saveIndex();
      return { learned: true, skill };
    } catch (e) {
      return { learned: false, reason: e.message };
    }
  }

  /**
   * Execute a skill by ID with given parameters
   */
  async executeSkill(skillId, params = {}, opts = {}) {
    const { chatId = 'system', onProgress } = opts;
    const skill = this.skills.get(skillId);
    if (!skill) return { success: false, error: `Skill not found: ${skillId}` };

    const startTime = Date.now();
    const results = [];

    // If it's a file-based skill, execute its module
    if (skill.type === 'file' && skill.file) {
      let skillModule;
      try {
        skillModule = require(path.join(SKILLS_DIR, skill.file));
      } catch (loadErr) {
        this._recordExecution(skillId, false, Date.now() - startTime);
        return { success: false, error: `Failed to load skill module ${skill.file}: ${loadErr.message}` };
      }
      try {
        const output = await skillModule.execute(params, { chatId, callAI: this.callAI, executeAction: this.executeAction });
        this._recordExecution(skillId, true, Date.now() - startTime);
        return { success: true, output, duration: Date.now() - startTime };
      } catch (e) {
        this._recordExecution(skillId, false, Date.now() - startTime);
        return { success: false, error: e.message };
      }
    }

    // Execute step-by-step for dynamic/learned skills
    for (let i = 0; i < (skill.steps || []).length; i++) {
      const step = skill.steps[i];
      if (onProgress) onProgress({ step: i + 1, total: skill.steps.length, desc: step.desc });

      try {
        const resolvedParams = this._resolveTemplates(step.params || {}, params, results);
        let stepResult;

        if (step.action === 'ai_call') {
          const aiResult = await this.callAIWithFallback(
            resolvedParams.model || 'gemini-2.5-flash',
            [{ role: 'user', content: resolvedParams.prompt || resolvedParams.task || '' }],
            resolvedParams.system || '',
            chatId, { allowMcp: false }
          );
          stepResult = aiResult?.text || '';
        } else if (step.action === 'delegate') {
          stepResult = await this.runSubAgentLoop(
            chatId,
            resolvedParams.task || '',
            resolvedParams.role || 'coder',
            resolvedParams.context || '',
            resolvedParams.maxSteps || 7
          );
        } else if (this.executeAction) {
          const actionResult = await this.executeAction(chatId, { name: step.action, body: resolvedParams.body || resolvedParams.task || '' });
          stepResult = actionResult?.output || actionResult?.text || actionResult || '';
        } else {
          stepResult = `[Skip: no handler for ${step.action}]`;
        }

        results.push({ step: i, action: step.action, desc: step.desc, output: stepResult, success: true });
      } catch (e) {
        results.push({ step: i, action: step.action, desc: step.desc, error: e.message, success: false });
      }
    }

    const duration = Date.now() - startTime;
    const allSuccess = results.every(r => r.success);
    this._recordExecution(skillId, allSuccess, duration);

    // Combine outputs
    const output = results.map(r => {
      if (r.success) return `[${r.desc}]\n${typeof r.output === 'string' ? r.output : JSON.stringify(r.output)}`;
      return `[${r.desc}] ERROR: ${r.error}`;
    }).join('\n\n---\n\n');

    return { success: allSuccess, output, results, duration };
  }

  _resolveTemplates(obj, params, prevResults) {
    const resolved = {};
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        resolved[key] = val.replace(/\{\{(\w+)\}\}/g, (_, name) => {
          if (params[name] !== undefined) return params[name];
          const stepMatch = name.match(/^step(\d+)$/);
          if (stepMatch && prevResults[parseInt(stepMatch[1])]) {
            const r = prevResults[parseInt(stepMatch[1])];
            return typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
          }
          return `{{${name}}}`;
        });
      } else {
        resolved[key] = val;
      }
    }
    return resolved;
  }

  _recordExecution(skillId, success, duration) {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    skill.usageCount = (skill.usageCount || 0) + 1;
    const oldAvg = skill.avgDuration || 0;
    skill.avgDuration = Math.round((oldAvg * (skill.usageCount - 1) + duration) / skill.usageCount);
    const oldRate = skill.successRate ?? 1.0;
    skill.successRate = (oldRate * (skill.usageCount - 1) + (success ? 1 : 0)) / skill.usageCount;
    skill.lastUsed = new Date().toISOString();
    this.skills.set(skillId, skill);
    this._saveIndex();
  }

  /**
   * Search skills by query
   */
  searchSkills(query, limit = 5) {
    const qLow = query.toLowerCase();
    const scored = [];
    for (const [id, skill] of this.skills) {
      const text = `${skill.name} ${skill.desc} ${(skill.tags || []).join(' ')} ${skill.category || ''}`.toLowerCase();
      const words = qLow.split(/\s+/).filter(w => w.length > 1);
      const score = words.filter(w => text.includes(w)).length / Math.max(words.length, 1);
      if (score > 0.2) scored.push({ id, skill, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Find the best skill for a task (AI-powered)
   */
  async findSkillForTask(taskDescription, chatId = 'system') {
    // Quick keyword search first
    const candidates = this.searchSkills(taskDescription, 10);
    if (candidates.length === 0) return null;

    if (candidates.length === 1 && candidates[0].score > 0.6) {
      return candidates[0];
    }

    // AI picks the best match
    const prompt = `Which skill best matches this task? Return ONLY the skill ID or "none".

Task: ${taskDescription}

Available skills:
${candidates.map(c => `- ${c.id}: ${c.skill.name} - ${c.skill.desc}`).join('\n')}

Reply with just the skill ID or "none".`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Skill matcher. Reply with skill ID only.',
        chatId, { allowMcp: false }
      );
      const chosen = (result?.text || '').trim().toLowerCase();
      if (chosen === 'none') return null;
      const match = candidates.find(c => c.id === chosen || c.id.includes(chosen));
      return match || candidates[0];
    } catch {
      return candidates[0];
    }
  }

  /**
   * Compose multiple skills into a pipeline
   */
  async composeSkills(skillIds, opts = {}) {
    const { name, desc, chatId = 'system' } = opts;
    const allSteps = [];
    const allTags = new Set();

    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (!skill) continue;
      for (const step of (skill.steps || [])) allSteps.push(step);
      for (const tag of (skill.tags || [])) allTags.add(tag);
    }

    const composed = {
      id: `composed_${crypto.randomBytes(4).toString('hex')}`,
      name: name || `Pipeline: ${skillIds.join(' + ')}`,
      desc: desc || `Composed from: ${skillIds.join(', ')}`,
      category: 'automation',
      tags: [...allTags, 'composed'],
      inputSchema: {},
      steps: allSteps,
      outputFormat: 'mixed',
      estimatedTime: 'slow',
      type: 'composed',
      composedFrom: skillIds,
      createdAt: new Date().toISOString(),
      usageCount: 0, avgDuration: 0, successRate: 1.0,
    };

    this.skills.set(composed.id, composed);
    this._saveIndex();
    return composed;
  }

  /**
   * Generate a .js skill file for complex skills
   */
  async generateSkillFile(skillId) {
    const skill = this.skills.get(skillId);
    if (!skill) return null;

    const code = `'use strict';

// Auto-generated skill: ${skill.name}
// Created: ${skill.createdAt || new Date().toISOString()}

const meta = {
  id: ${JSON.stringify(skill.id)},
  name: ${JSON.stringify(skill.name)},
  desc: ${JSON.stringify(skill.desc)},
  category: ${JSON.stringify(skill.category || 'general')},
  tags: ${JSON.stringify(skill.tags || [])},
  inputSchema: ${JSON.stringify(skill.inputSchema || {})},
  outputFormat: ${JSON.stringify(skill.outputFormat || 'text')},
  estimatedTime: ${JSON.stringify(skill.estimatedTime || 'medium')},
};

async function execute(params, ctx) {
  const { chatId, callAI, executeAction } = ctx;
  const results = [];

${(skill.steps || []).map((step, i) => `
  // Step ${i + 1}: ${step.desc || step.action}
  try {
    ${step.action === 'ai_call' ? `const r${i} = await callAI('gemini-2.5-flash', [{role:'user',content:${JSON.stringify(step.params?.prompt || step.params?.task || '')}}], '', chatId);
    results.push(r${i}?.text || '');` :
    step.action === 'delegate' ? `const r${i} = await ctx.runSubAgentLoop(chatId, ${JSON.stringify(step.params?.task || '')}, ${JSON.stringify(step.params?.role || 'coder')}, '', 7);
    results.push(r${i} || '');` :
    `const r${i} = await executeAction(chatId, {name: ${JSON.stringify(step.action)}, body: ${JSON.stringify(step.params?.body || '')}});
    results.push(r${i}?.output || '');`}
  } catch (e${i}) { results.push('Error: ' + e${i}.message); }`).join('\n')}

  return results.join('\\n\\n---\\n\\n');
}

module.exports = { meta, execute };
`;

    if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const filePath = path.join(SKILLS_DIR, `${skill.id}.js`);
    fs.writeFileSync(filePath, code);

    skill.type = 'file';
    skill.file = `${skill.id}.js`;
    this.skills.set(skill.id, skill);
    this._saveIndex();

    return filePath;
  }

  getAllSkills() { return Object.fromEntries(this.skills); }
  getSkill(id) { return this.skills.get(id) || null; }
  deleteSkill(id) {
    if (this.skills.has(id)) {
      const skill = this.skills.get(id);
      if (skill.file) {
        try { fs.unlinkSync(path.join(SKILLS_DIR, skill.file)); } catch {}
      }
      this.skills.delete(id);
      this._saveIndex();
      return true;
    }
    return false;
  }
  getStats() {
    const all = [...this.skills.values()];
    return {
      total: all.length,
      byType: { file: all.filter(s => s.type === 'file').length, dynamic: all.filter(s => s.type === 'dynamic').length, learned: all.filter(s => s.type === 'learned').length, composed: all.filter(s => s.type === 'composed').length },
      byCategory: all.reduce((acc, s) => { acc[s.category || 'other'] = (acc[s.category || 'other'] || 0) + 1; return acc; }, {}),
      totalExecutions: all.reduce((sum, s) => sum + (s.usageCount || 0), 0),
    };
  }
}

module.exports = { SkillManager };
