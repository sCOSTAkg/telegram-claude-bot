/**
 * AutonomousExecutor — autonomous task planning & execution engine
 * Wires together: runSubAgentLoop, executeAction, callAI, globalPool, pluginManager
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── ToolRouter: unified interface to all existing tools ───

class ToolRouter {
  constructor({ executeAction, callAI, callAIWithFallback, runSubAgentLoop, getEffectiveAgents, pluginManager }) {
    this.executeAction = executeAction;
    this.callAI = callAI;
    this.callAIWithFallback = callAIWithFallback;
    this.runSubAgentLoop = runSubAgentLoop;
    this.getEffectiveAgents = getEffectiveAgents;
    this.pluginManager = pluginManager;
  }

  async route(chatId, toolName, params = {}) {
    // 1) Delegate to sub-agent
    if (toolName === 'delegate' || toolName === 'sub_agent') {
      const { role = 'coder', task, context = '', maxSteps = 7 } = params;
      return this.runSubAgentLoop(chatId, task, role, context, maxSteps);
    }

    // 2) AI call (planning, analysis, synthesis)
    if (toolName === 'ai_call') {
      const { model, messages, systemPrompt } = params;
      const result = await this.callAIWithFallback(model, messages, systemPrompt, chatId);
      return { success: true, output: result.text || '' };
    }

    // 3) Built-in action (bash, search, web_fetch, image, etc.)
    const action = { name: toolName, body: params.body || params.task || '' };
    return this.executeAction(chatId, action);
  }

  getToolManifest() {
    const builtIn = [
      'bash — execute shell commands',
      'search — web search',
      'web_fetch — fetch URL content',
      'read_file — read file contents',
      'write_file — create/write files',
      'edit_file — modify existing files',
      'image — generate images',
      'video — generate videos',
      'http_request — HTTP API calls',
      'delegate — delegate to specialist sub-agent (role: coder/analyst/researcher/...)',
      'plan — create execution plan',
      'mcp — call MCP server tools',
    ];
    return builtIn.join('\n');
  }
}

// ─── AutonomousExecutor: the autonomous loop ───

class AutonomousExecutor {
  constructor({ toolRouter, callAI, callAIWithFallback, globalPool, sendUpdate, persistDir }) {
    this.toolRouter = toolRouter;
    this.callAI = callAI;
    this.callAIWithFallback = callAIWithFallback;
    this.globalPool = globalPool;
    this.sendUpdate = sendUpdate;
    this.persistDir = persistDir;
  }

  // Main entry point
  async execute(chatId, taskDescription, opts = {}) {
    const { onProgress, maxIterations = 20 } = opts;
    const taskId = `task_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const progress = (msg) => {
      if (onProgress) onProgress({ taskId, message: msg });
    };

    try {
      // 1) Create plan
      progress('Planning...');
      const plan = await this._createPlan(chatId, taskDescription, taskId, maxIterations);
      if (!plan || !plan.steps || plan.steps.length === 0) {
        return { success: false, output: 'Failed to create execution plan' };
      }
      progress(`Plan created: ${plan.steps.length} steps`);
      this._savePlanState(chatId, taskId, plan);

      // 2) Execute plan
      const result = await this._executePlan(chatId, plan, progress);

      // 3) Synthesize result
      progress('Synthesizing results...');
      const synthesis = await this._synthesize(chatId, plan);

      plan.status = plan.steps.every(s => s.status === 'done') ? 'completed' : 'partial';
      plan.finalResult = synthesis;
      this._savePlanState(chatId, taskId, plan);

      const successCount = plan.steps.filter(s => s.status === 'done').length;
      progress(`Done: ${successCount}/${plan.steps.length} steps completed`);

      return {
        success: plan.status === 'completed',
        output: synthesis,
        taskId,
        plan: { id: taskId, goal: plan.goal, status: plan.status, stepsTotal: plan.steps.length, stepsDone: successCount },
      };
    } catch (e) {
      progress(`Error: ${e.message}`);
      return { success: false, output: `Autonomous execution failed: ${e.message}`, taskId };
    }
  }

  // Resume from persisted state
  async resume(chatId, taskId, opts = {}) {
    const plan = this._loadPlanState(chatId, taskId);
    if (!plan) return { success: false, output: `Task ${taskId} not found` };

    const { onProgress } = opts;
    const progress = (msg) => { if (onProgress) onProgress({ taskId, message: msg }); };

    // Reset failed steps for retry
    for (const step of plan.steps) {
      if (step.status === 'failed' && step.attempts < step.maxAttempts) {
        step.status = 'pending';
      }
    }
    plan.status = 'running';
    this._savePlanState(chatId, taskId, plan);

    progress(`Resuming task: ${plan.goal} (${plan.steps.filter(s => s.status === 'pending').length} steps remaining)`);
    await this._executePlan(chatId, plan, progress);

    const synthesis = await this._synthesize(chatId, plan);
    plan.status = plan.steps.every(s => s.status === 'done') ? 'completed' : 'partial';
    plan.finalResult = synthesis;
    this._savePlanState(chatId, taskId, plan);

    return { success: plan.status === 'completed', output: synthesis, taskId };
  }

  // List pending tasks for a chat
  listPending(chatId) {
    const dir = path.join(this.persistDir, String(chatId));
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const tasks = [];
    for (const f of files) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (plan.status === 'running' || plan.status === 'paused') {
          const done = plan.steps.filter(s => s.status === 'done').length;
          tasks.push({ id: plan.id, goal: plan.goal, status: plan.status, progress: `${done}/${plan.steps.length}` });
        }
      } catch (_) {}
    }
    return tasks;
  }

  // ─── Internal methods ───

  async _createPlan(chatId, task, taskId, maxIterations) {
    const toolManifest = this.toolRouter.getToolManifest();
    const systemPrompt = `You are a task planner. Given a goal, create a JSON execution plan.
Available tools:\n${toolManifest}

Available specialist roles for delegation: coder, researcher, analyst, writer, reviewer, designer, marketer, seo_specialist, devops, tester, translator, data_scientist

IMPORTANT RULES:
- For simple tasks (1-2 actions), create 1-3 steps max
- For complex tasks, create up to 10 steps
- Each step should be atomic and achievable
- Use "deps" to specify step dependencies (array of step ids)
- Independent steps will run in parallel
- Prefer "delegate" tool with appropriate role for complex substeps
- Use direct tools (bash, search, web_fetch, write_file) for simple operations

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "goal": "...",
  "steps": [
    {"id": 1, "task": "description", "role": "researcher", "tool": "delegate", "toolParams": {}, "deps": [], "maxAttempts": 2},
    {"id": 2, "task": "description", "role": "coder", "tool": "delegate", "toolParams": {}, "deps": [1], "maxAttempts": 3}
  ]
}`;

    const messages = [{ role: 'user', content: `Create execution plan for: ${task}` }];

    // Use fast model for planning
    const planModels = ['gemini-2.5-flash', 'groq-llama3-70b', 'gemini-2.0-flash'];
    let planText = null;

    for (const model of planModels) {
      try {
        const result = await this.callAIWithFallback(model, messages, systemPrompt, chatId);
        planText = (result.text || '').trim();
        break;
      } catch (_) { continue; }
    }

    if (!planText) {
      // Fallback: use whatever model the user has configured
      const result = await this.callAIWithFallback('gemini-2.0-flash', messages, systemPrompt, chatId);
      planText = (result.text || '').trim();
    }

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = planText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, planText];
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // Try to extract JSON object directly
      const objMatch = planText.match(/\{[\s\S]*?\}/) || planText.match(/\{[\s\S]*\}/);
      if (objMatch) parsed = JSON.parse(objMatch[0]);
      else throw new Error(`Failed to parse plan: ${e.message}`);
    }

    // Normalize plan structure
    const plan = {
      id: taskId,
      goal: parsed.goal || task,
      status: 'running',
      steps: (parsed.steps || []).map((s, i) => ({
        id: s.id || i + 1,
        task: s.task,
        role: s.role || 'coder',
        tool: s.tool || 'delegate',
        toolParams: s.toolParams || {},
        deps: s.deps || [],
        status: 'pending',
        result: null,
        attempts: 0,
        maxAttempts: s.maxAttempts || 2,
      })),
      context: {},
      maxIterations,
      createdAt: Date.now(),
    };

    return plan;
  }

  async _executePlan(chatId, plan, progress) {
    let iterations = 0;

    while (iterations < plan.maxIterations) {
      iterations++;

      // Find ready steps (deps satisfied, status pending)
      const readySteps = plan.steps.filter(s => {
        if (s.status !== 'pending') return false;
        return s.deps.every(depId => {
          const dep = plan.steps.find(x => x.id === depId);
          return dep && dep.status === 'done';
        });
      });

      if (readySteps.length === 0) {
        // No more steps to execute
        break;
      }

      // Execute ready steps (parallel if multiple, via globalPool)
      if (readySteps.length === 1) {
        await this._executeStep(chatId, readySteps[0], plan, progress);
      } else {
        // Parallel execution via globalPool
        const promises = readySteps.map(step =>
          this.globalPool.submit(
            `auto_${plan.id}_step_${step.id}`,
            () => this._executeStep(chatId, step, plan, progress),
            { role: step.role, priority: 5 }
          )
        );
        await Promise.allSettled(promises);
      }

      this._savePlanState(chatId, plan.id, plan);
    }
  }

  async _executeStep(chatId, step, plan, progress) {
    step.status = 'running';
    step.attempts++;
    progress(`Step ${step.id}/${plan.steps.length}: ${step.task.slice(0, 60)}...`);

    // Gather context from completed deps
    const depsContext = step.deps
      .map(depId => {
        const dep = plan.steps.find(x => x.id === depId);
        if (dep && dep.status === 'done' && dep.result) {
          return `[Step ${dep.id} "${dep.task}" result]: ${dep.result.slice(0, 1000)}`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n\n');

    try {
      let result;

      if (step.tool === 'delegate' || step.tool === 'sub_agent') {
        // Complex step — delegate to sub-agent
        result = await this.toolRouter.route(chatId, 'delegate', {
          role: step.role,
          task: step.task,
          context: depsContext,
          maxSteps: 7,
        });
      } else {
        // Simple step — direct tool call
        const params = { ...step.toolParams, body: step.task, task: step.task };
        if (depsContext) params.body = `${step.task}\n\nContext:\n${depsContext}`;
        result = await this.toolRouter.route(chatId, step.tool, params);
      }

      if (result.success) {
        step.status = 'done';
        step.result = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        plan.context[`step_${step.id}`] = step.result.slice(0, 2000);
        progress(`Step ${step.id} done`);
      } else {
        throw new Error(result.output || 'Step failed');
      }
    } catch (e) {
      if (step.attempts < step.maxAttempts) {
        // Retry with error analysis
        progress(`Step ${step.id} failed (attempt ${step.attempts}/${step.maxAttempts}), retrying...`);
        const alternative = await this._analyzeError(chatId, step, e.message, depsContext);
        if (alternative) {
          step.task = alternative;
        }
        step.status = 'pending';
      } else {
        step.status = 'failed';
        step.result = `Error: ${e.message}`;
        progress(`Step ${step.id} failed: ${e.message.slice(0, 80)}`);
      }
    }
  }

  async _analyzeError(chatId, step, error, context) {
    try {
      const messages = [{
        role: 'user',
        content: `Task failed: "${step.task}"\nRole: ${step.role}\nTool: ${step.tool}\nError: ${error}\nContext: ${context?.slice(0, 500) || 'none'}\n\nSuggest a modified approach in 1-2 sentences. Just the new task description, nothing else.`
      }];
      const result = await this.callAIWithFallback('gemini-2.5-flash', messages, 'You are an error analyst. Suggest alternative approaches concisely.', chatId);
      return (result.text || '').trim().slice(0, 500) || null;
    } catch (_) {
      return null;
    }
  }

  async _synthesize(chatId, plan) {
    const completedSteps = plan.steps.filter(s => s.status === 'done');
    if (completedSteps.length === 0) {
      return 'No steps completed successfully.';
    }

    const stepsSummary = completedSteps.map(s =>
      `Step ${s.id} (${s.role}): ${s.task}\nResult: ${(s.result || '').slice(0, 800)}`
    ).join('\n\n---\n\n');

    const failedSteps = plan.steps.filter(s => s.status === 'failed');
    const failedSummary = failedSteps.length > 0
      ? `\n\nFailed steps: ${failedSteps.map(s => `${s.id}: ${s.task} — ${s.result}`).join('; ')}`
      : '';

    try {
      const messages = [{
        role: 'user',
        content: `Goal: ${plan.goal}\n\nCompleted steps:\n${stepsSummary}${failedSummary}\n\nSynthesize a comprehensive final result in Russian. Include all key outputs, code, findings. Be detailed and actionable.`
      }];
      const result = await this.callAIWithFallback('gemini-2.5-flash', messages, 'You are a task synthesizer. Combine step results into a coherent final deliverable. Respond in Russian.', chatId);
      return (result.text || '').trim() || stepsSummary;
    } catch (_) {
      return stepsSummary;
    }
  }

  // ─── Persistence ───

  _savePlanState(chatId, taskId, plan) {
    try {
      const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const dir = path.join(this.persistDir, safeChatId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${safeTaskId}.json`), JSON.stringify(plan, null, 2));
    } catch (e) {
      console.error(`[AutonomousExecutor] Save error: ${e.message}`);
    }
  }

  _loadPlanState(chatId, taskId) {
    try {
      const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(this.persistDir, safeChatId, `${safeTaskId}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }
}

module.exports = { AutonomousExecutor, ToolRouter };
