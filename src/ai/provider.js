/**
 * Unified AI Provider Interface
 * Abstracts all AI model providers (Anthropic, OpenAI, Google, Groq, DeepSeek, OpenRouter, Ollama)
 * Uses canonical MODEL_MAP from config/models.js — no duplicates
 */

const { spawn } = require('child_process');
const os = require('os');
const { MODEL_MAP } = require('../../config/models');

const GEMINI_THINKING_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-3-flash-preview'];

class AIProvider {
  constructor(options = {}) {
    this.claudePath = options.claudePath || '/opt/homebrew/bin/claude';
    this.geminiCliPath = options.geminiCliPath || '/opt/homebrew/bin/gemini';
    this.defaultTimeout = options.defaultTimeout || 120000;
  }

  getProvider(model) {
    if (model.startsWith('claude')) return 'anthropic';
    if (model === 'gemini-cli') return 'google-cli';
    if (model.startsWith('codex-cli')) return 'codex-cli';
    if (model.startsWith('gpt') || model.startsWith('codex')) return 'openai';
    if (model.startsWith('gemini')) return 'google';
    if (model.startsWith('deepseek')) return 'deepseek';
    if (model.startsWith('ollama-')) return 'ollama';
    if (['llama', 'mixtral', 'gemma'].some(m => model.includes(m))) return 'groq';
    // OpenRouter models contain '/' in mapped ID
    const mapped = MODEL_MAP[model] || model;
    if (mapped.includes('/')) return 'openrouter';
    return 'unknown';
  }

  getMappedModel(model) {
    return MODEL_MAP[model] || model;
  }

  async call(model, messages, systemPrompt, options = {}) {
    const { chatId = null, allowMcp = true, timeout = this.defaultTimeout } = options;
    const provider = this.getProvider(model);
    const modelId = this.getMappedModel(model);

    const start = Date.now();
    let result;

    try {
      switch (provider) {
        case 'anthropic':
          result = await this.callAnthropic(modelId, messages, systemPrompt, { chatId, allowMcp, timeout });
          break;
        case 'google-cli':
          result = await this.callGeminiCLI(modelId, messages, systemPrompt, { chatId, allowMcp, timeout });
          break;
        case 'openai':
          result = await this.callOpenAI(modelId, messages, systemPrompt, { chatId, timeout });
          break;
        case 'google':
          result = await this.callGemini(modelId, messages, systemPrompt, { chatId, timeout });
          break;
        case 'groq':
          result = await this.callGroq(modelId, messages, systemPrompt, { chatId, timeout });
          break;
        case 'deepseek':
          result = await this.callDeepSeek(modelId, messages, systemPrompt, { chatId, timeout });
          break;
        case 'openrouter':
          result = await this.callOpenRouter(modelId, messages, systemPrompt, { chatId, timeout });
          break;
        case 'ollama':
          result = await this.callOllama(modelId, messages, systemPrompt, { chatId, timeout });
          break;
        default:
          throw new Error(`Unknown provider: ${model}`);
      }

      return {
        ...result,
        ms: Date.now() - start,
        provider,
        model,
      };
    } catch (err) {
      throw new Error(`[${provider}/${model}] ${err.message}`);
    }
  }

  async callAnthropic(modelId, messages, systemPrompt, opts) {
    const { timeout = this.defaultTimeout } = opts;
    const prompt = this._buildPrompt(messages, systemPrompt);

    return new Promise((resolve, reject) => {
      const args = ['--no-cache', '--model', modelId, '--yolo'];
      const child = spawn(this.claudePath, args, {
        cwd: process.env.WORKING_DIR || os.homedir(),
        env: { ...process.env, CLAUDECODE: undefined },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      const killTimer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Exit code ${code}`));
        } else {
          resolve({ text: stdout.trim() || 'OK', usage: null });
        }
      });
    });
  }

  async callOpenAI(modelId, messages, systemPrompt, opts) {
    const { timeout = this.defaultTimeout } = opts;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);

    const isReasoning = /^(o[134]|o[134]-mini)/.test(modelId);
    const body = { model: modelId, messages: msgs };
    if (isReasoning) {
      body.max_completion_tokens = 16384;
    } else {
      body.max_tokens = 8192;
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response');
    return { text, usage: data.usage };
  }

  async callGemini(modelId, messages, systemPrompt, opts) {
    const { timeout = this.defaultTimeout } = opts;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const isThinking = GEMINI_THINKING_MODELS.includes(modelId);
    const isFlashThinking = isThinking && modelId.includes('flash');
    const genConfig = { maxOutputTokens: isThinking ? (isFlashThinking ? 8192 : 16384) : 8192 };
    if (isThinking) {
      genConfig.thinkingConfig = { thinkingBudget: isFlashThinking ? 2048 : 8192 };
    }

    const body = { contents, generationConfig: genConfig };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      }
    );

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text).join('') || '';
    if (!text && data.candidates?.[0]?.finishReason === 'SAFETY') {
      throw new Error('Blocked by safety filter');
    }
    return { text, usage: data.usageMetadata };
  }

  async callGroq(modelId, messages, systemPrompt, opts) {
    const { timeout = Math.min(opts.timeout || this.defaultTimeout, 90000) } = opts;
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not set');

    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 8192 }),
      signal: AbortSignal.timeout(timeout),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response');
    return { text, usage: data.usage };
  }

  async callDeepSeek(modelId, messages, systemPrompt, opts) {
    const { timeout = this.defaultTimeout } = opts;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 8192 }),
      signal: AbortSignal.timeout(timeout),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response');
    return { text, usage: data.usage };
  }

  async callOpenRouter(modelId, messages, systemPrompt, opts) {
    const { timeout = this.defaultTimeout } = opts;
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 8192 }),
      signal: AbortSignal.timeout(timeout),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response');
    return { text, usage: data.usage };
  }

  async callOllama(modelId, messages, systemPrompt, opts) {
    const { timeout = Math.min(opts.timeout || this.defaultTimeout, 120000) } = opts;
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';

    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);

    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: msgs, stream: false }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data.message?.content;
    if (!text) throw new Error('Ollama returned empty response');
    return { text, usage: { total_duration: data.total_duration, eval_count: data.eval_count } };
  }

  async callGeminiCLI(modelId, messages, systemPrompt, opts) {
    const { timeout = this.defaultTimeout } = opts;
    const prompt = this._buildPrompt(messages, systemPrompt);

    return new Promise((resolve, reject) => {
      const model = modelId === 'gemini-cli' ? 'gemini-2.5-pro' : modelId;
      const args = ['--prompt', prompt, '--yolo', '--model', model];

      const child = spawn(this.geminiCliPath, args, {
        cwd: process.env.WORKING_DIR || os.homedir(),
        env: { ...process.env, CLAUDECODE: undefined },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('error', (err) => reject(new Error(`Gemini CLI: ${err.message}`)));
      child.stdin.end();

      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      const killTimer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(stderr.trim() || `Exit code ${code}`));
        } else {
          resolve({ text: stdout.trim() || 'OK', usage: null });
        }
      });
    });
  }

  _buildPrompt(messages, systemPrompt) {
    let prompt = messages.map((m) => `${m.role}:\n${m.content}`).join('\n\n');
    if (systemPrompt) {
      prompt = `System instructions:\n${systemPrompt}\n\nUser prompt:\n${prompt}`;
    }
    return prompt;
  }
}

module.exports = AIProvider;
