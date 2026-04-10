const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const AIProvider = require('../src/ai/provider');

function makeSpawnMock(stdoutText = 'ok') {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {}, on() {} };
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdoutText));
      child.emit('close', 0);
    });
    return child;
  };
}

test('smoke: same input -> same provider/model/timeout/result shape (OpenAI)', async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 10 } };
      },
    };
  };

  const provider = new AIProvider({
    getUserConfig: () => ({ timeout: 42, apiKeys: { openai: 'k' }, modelSettings: {} }),
  });

  const inputMessages = [{ role: 'user', content: 'ping' }];
  const a = await provider.call('gpt-4.1-mini', inputMessages, 'sys', { chatId: 1 });
  const b = await provider.call('gpt-4.1-mini', inputMessages, 'sys', { chatId: 1 });

  assert.equal(a.provider, 'openai');
  assert.equal(a.model, 'gpt-4.1-mini');
  assert.equal(b.provider, a.provider);
  assert.equal(b.model, a.model);
  assert.equal(typeof a.text, 'string');
  assert.equal(typeof a.ms, 'number');
  assert.equal(typeof b.ms, 'number');

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /openai\.com/);
  assert.ok(calls[0].opts.signal, 'timeout signal must be present');
});

test('smoke: same input -> same provider/model/timeout/result shape (Anthropic CLI spawn)', async () => {
  const provider = new AIProvider({
    spawn: makeSpawnMock('cli-result'),
    buildClaudeCliArgs: () => ({ args: ['--model', 'claude-3-5-sonnet-20241022'] }),
    getUserConfig: () => ({ timeout: 15, modelSettings: {}, apiKeys: {} }),
  });

  const inputMessages = [{ role: 'user', content: 'ping' }];
  const a = await provider.call('claude-sonnet', inputMessages, 'sys', { allowMcp: true, chatId: 7 });
  const b = await provider.call('claude-sonnet', inputMessages, 'sys', { allowMcp: true, chatId: 7 });

  assert.equal(a.provider, 'anthropic');
  assert.equal(a.model, 'claude-sonnet');
  assert.equal(b.provider, a.provider);
  assert.equal(b.model, a.model);
  assert.equal(a.text, 'cli-result');
  assert.equal(b.text, 'cli-result');
  assert.equal(typeof a.ms, 'number');
});
