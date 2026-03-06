'use strict';

/**
 * INTEGRATION HUB v1.0
 *
 * Dynamic integration manager for connecting external APIs, webhooks, services.
 * Bot can autonomously discover, configure, and use integrations.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INTEGRATIONS_FILE = path.join(__dirname, '..', 'data', 'integrations.json');
const WEBHOOKS_FILE = path.join(__dirname, '..', 'data', 'webhooks.json');

// Built-in integration templates
const INTEGRATION_TEMPLATES = {
  rest_api: {
    type: 'rest_api',
    label: 'REST API',
    desc: 'Connect to any REST API',
    configSchema: { baseUrl: 'string', headers: 'object', auth: 'object' },
  },
  webhook: {
    type: 'webhook',
    label: 'Webhook',
    desc: 'Send/receive webhooks',
    configSchema: { url: 'string', method: 'string', headers: 'object' },
  },
  database: {
    type: 'database',
    label: 'Database',
    desc: 'Connect to database (via API)',
    configSchema: { type: 'string', connectionString: 'string' },
  },
  google_sheets: {
    type: 'google_sheets',
    label: 'Google Sheets',
    desc: 'Read/write Google Sheets',
    configSchema: { spreadsheetId: 'string', apiKey: 'string' },
  },
  notion: {
    type: 'notion',
    label: 'Notion',
    desc: 'Read/write Notion pages and databases',
    configSchema: { apiKey: 'string', databaseId: 'string' },
  },
  github: {
    type: 'github',
    label: 'GitHub',
    desc: 'GitHub API integration',
    configSchema: { token: 'string', owner: 'string', repo: 'string' },
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    desc: 'OpenAI API calls',
    configSchema: { apiKey: 'string', model: 'string' },
  },
  telegram_channel: {
    type: 'telegram_channel',
    label: 'Telegram Channel',
    desc: 'Post to Telegram channel',
    configSchema: { channelId: 'string', botToken: 'string' },
  },
  email: {
    type: 'email',
    label: 'Email (SMTP)',
    desc: 'Send emails via SMTP',
    configSchema: { host: 'string', port: 'number', user: 'string', pass: 'string' },
  },
  scheduler: {
    type: 'scheduler',
    label: 'Task Scheduler',
    desc: 'Schedule recurring tasks',
    configSchema: { cron: 'string', task: 'string' },
  },
};

class IntegrationHub {
  constructor({ callAI, callAIWithFallback, executeAction }) {
    this.callAI = callAI;
    this.callAIWithFallback = callAIWithFallback;
    this.executeAction = executeAction;
    this.integrations = new Map();
    this.webhooks = new Map();
    this.scheduledTasks = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(INTEGRATIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf8'));
        for (const [id, int] of Object.entries(data)) this.integrations.set(id, int);
      }
      if (fs.existsSync(WEBHOOKS_FILE)) {
        const data = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8'));
        for (const [id, wh] of Object.entries(data)) this.webhooks.set(id, wh);
      }
    } catch (e) {
      console.error('[IntegrationHub] Load error:', e.message);
    }
  }

  _save() {
    try {
      const dir = path.dirname(INTEGRATIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(Object.fromEntries(this.integrations), null, 2));
      fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(Object.fromEntries(this.webhooks), null, 2));
    } catch (e) {
      console.error('[IntegrationHub] Save error:', e.message);
    }
  }

  /**
   * Register a new integration
   */
  addIntegration(name, type, config = {}) {
    const template = INTEGRATION_TEMPLATES[type];
    const id = `int_${crypto.randomBytes(4).toString('hex')}`;
    const integration = {
      id, name, type,
      label: template?.label || type,
      desc: template?.desc || name,
      config,
      status: 'active',
      createdAt: new Date().toISOString(),
      usageCount: 0,
      lastUsed: null,
      errors: [],
    };
    this.integrations.set(id, integration);
    this._save();
    console.log(`[IntegrationHub] Added: ${name} (${type})`);
    return integration;
  }

  /**
   * AI-powered integration setup: describe what you need, AI configures it
   */
  async autoSetupIntegration(description, opts = {}) {
    const { chatId = 'system' } = opts;

    const prompt = `User wants to set up an integration. Analyze and return JSON configuration.

Request: ${description}

Available templates: ${Object.keys(INTEGRATION_TEMPLATES).join(', ')}

Return JSON:
{
  "name": "integration name",
  "type": "template_type or custom",
  "config": { ... configuration based on template schema ... },
  "instructions": "any setup steps the user needs to take (get API keys, etc)",
  "envVars": ["ENV_VAR_NAME_1"],
  "testCommand": "command or URL to test the integration"
}`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Integration architect. Return precise JSON configs.',
        chatId, { allowMcp: false }
      );
      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');

      const setup = JSON.parse(jsonMatch[0]);
      const integration = this.addIntegration(
        setup.name || 'Custom Integration',
        setup.type || 'rest_api',
        setup.config || {}
      );

      return {
        success: true,
        integration,
        instructions: setup.instructions || '',
        envVars: setup.envVars || [],
        testCommand: setup.testCommand || '',
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Execute an integration action
   */
  async executeIntegration(integrationId, action, params = {}, opts = {}) {
    const { chatId = 'system' } = opts;
    const integration = this.integrations.get(integrationId);
    if (!integration) return { success: false, error: `Integration not found: ${integrationId}` };

    const startTime = Date.now();

    try {
      let result;

      switch (integration.type) {
        case 'rest_api':
        case 'webhook':
          result = await this._executeHttpIntegration(integration, action, params);
          break;
        case 'telegram_channel':
          result = await this._executeTelegramIntegration(integration, action, params);
          break;
        case 'github':
          result = await this._executeGithubIntegration(integration, action, params);
          break;
        case 'scheduler':
          result = this._executeSchedulerIntegration(integration, action, params);
          break;
        default:
          // Generic: use AI to figure out the right call
          result = await this._executeGenericIntegration(integration, action, params, chatId);
      }

      integration.usageCount++;
      integration.lastUsed = new Date().toISOString();
      this.integrations.set(integrationId, integration);
      this._save();

      return { success: true, result, duration: Date.now() - startTime };
    } catch (e) {
      integration.errors.push({ time: new Date().toISOString(), error: e.message });
      if (integration.errors.length > 10) integration.errors = integration.errors.slice(-10);
      this.integrations.set(integrationId, integration);
      this._save();
      return { success: false, error: e.message, duration: Date.now() - startTime };
    }
  }

  async _executeHttpIntegration(integration, action, params) {
    const { baseUrl, url, headers = {}, auth } = integration.config;
    const targetUrl = params.url || `${baseUrl || url}${params.path || ''}`;
    const method = params.method || integration.config.method || 'GET';

    const fetchOpts = { method, headers: { ...headers } };
    if (auth?.type === 'bearer') fetchOpts.headers['Authorization'] = `Bearer ${auth.token || process.env[auth.envVar] || ''}`;
    if (auth?.type === 'basic') fetchOpts.headers['Authorization'] = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
    if (params.body) {
      fetchOpts.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
      if (!fetchOpts.headers['Content-Type']) fetchOpts.headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(targetUrl, fetchOpts);
    const contentType = resp.headers.get('content-type') || '';
    const body = contentType.includes('json') ? await resp.json() : await resp.text();
    return { status: resp.status, body, ok: resp.ok };
  }

  async _executeTelegramIntegration(integration, action, params) {
    const { channelId, botToken } = integration.config;
    const token = botToken || process.env.TELEGRAM_BOT_TOKEN;
    const apiUrl = `https://api.telegram.org/bot${token}`;

    if (action === 'send' || action === 'post') {
      const resp = await fetch(`${apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: channelId || params.chatId, text: params.text, parse_mode: 'Markdown' }),
      });
      return resp.json();
    }
    return { error: `Unknown action: ${action}` };
  }

  async _executeGithubIntegration(integration, action, params) {
    const { token, owner, repo } = integration.config;
    const ghToken = token || process.env.GITHUB_TOKEN;
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const headers = { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sCORP-Bot' };

    const actions = {
      issues: () => fetch(`${baseUrl}/issues`, { headers }),
      create_issue: () => fetch(`${baseUrl}/issues`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: params.title, body: params.body }) }),
      pulls: () => fetch(`${baseUrl}/pulls`, { headers }),
      contents: () => fetch(`${baseUrl}/contents/${params.path || ''}`, { headers }),
    };

    const handler = actions[action];
    if (!handler) return { error: `Unknown action: ${action}` };
    const resp = await handler();
    return resp.json();
  }

  _executeSchedulerIntegration(integration, action, params) {
    const id = `sched_${crypto.randomBytes(4).toString('hex')}`;
    if (action === 'add') {
      this.scheduledTasks.set(id, {
        id, cron: params.cron || integration.config.cron,
        task: params.task || integration.config.task,
        createdAt: new Date().toISOString(), active: true,
      });
      return { scheduled: true, id };
    }
    if (action === 'list') return [...this.scheduledTasks.values()];
    if (action === 'remove') { this.scheduledTasks.delete(params.id); return { removed: true }; }
    return { error: `Unknown action: ${action}` };
  }

  async _executeGenericIntegration(integration, action, params, chatId) {
    const prompt = `Execute this integration action and return the result as a bash command or API call.

Integration: ${integration.name} (${integration.type})
Config: ${JSON.stringify(integration.config)}
Action: ${action}
Params: ${JSON.stringify(params)}

Return ONLY a single bash command (curl, etc.) that executes this action.`;

    const result = await this.callAIWithFallback(
      'gemini-2.5-flash',
      [{ role: 'user', content: prompt }],
      'Return only the command. No explanation.',
      chatId, { allowMcp: false }
    );
    const cmd = (result?.text || '').trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    if (!cmd) throw new Error('No command generated');

    const actionResult = await this.executeAction(chatId, { name: 'bash', body: cmd });
    return actionResult;
  }

  /**
   * AI discovers what integrations would be useful for a task
   */
  async suggestIntegrations(taskDescription, chatId = 'system') {
    const existing = [...this.integrations.values()].map(i => `${i.name} (${i.type})`);

    const prompt = `What integrations would help with this task? Return JSON.

Task: ${taskDescription}
Already connected: ${existing.join(', ') || 'none'}
Available templates: ${Object.keys(INTEGRATION_TEMPLATES).join(', ')}

Return JSON:
{
  "suggestions": [
    {"type": "template_type", "name": "Integration Name", "reason": "why it helps", "priority": "high|medium|low"}
  ],
  "existingUseful": ["id of existing integrations that can help"]
}`;

    try {
      const result = await this.callAIWithFallback(
        'gemini-2.5-flash',
        [{ role: 'user', content: prompt }],
        'Integration advisor. Return JSON only.',
        chatId, { allowMcp: false }
      );
      const text = (result?.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { suggestions: [], existingUseful: [] };
      return JSON.parse(jsonMatch[0]);
    } catch {
      return { suggestions: [], existingUseful: [] };
    }
  }

  // Getters
  getIntegration(id) { return this.integrations.get(id) || null; }
  getAllIntegrations() { return Object.fromEntries(this.integrations); }
  getTemplates() { return INTEGRATION_TEMPLATES; }
  getByType(type) { return [...this.integrations.values()].filter(i => i.type === type); }

  removeIntegration(id) {
    if (this.integrations.has(id)) {
      this.integrations.delete(id);
      this._save();
      return true;
    }
    return false;
  }

  updateConfig(id, newConfig) {
    const int = this.integrations.get(id);
    if (!int) return false;
    int.config = { ...int.config, ...newConfig };
    this.integrations.set(id, int);
    this._save();
    return true;
  }

  getStats() {
    const all = [...this.integrations.values()];
    return {
      total: all.length,
      active: all.filter(i => i.status === 'active').length,
      byType: all.reduce((acc, i) => { acc[i.type] = (acc[i.type] || 0) + 1; return acc; }, {}),
      totalUsage: all.reduce((sum, i) => sum + (i.usageCount || 0), 0),
    };
  }
}

module.exports = { IntegrationHub, INTEGRATION_TEMPLATES };
