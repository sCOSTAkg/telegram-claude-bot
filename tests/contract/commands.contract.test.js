const test = require('node:test');
const assert = require('node:assert/strict');
const { createContractCommands } = require('../../src/bot/commands/contract-commands');

function createHarness() {
  const sent = [];
  const tgCalls = [];
  const handlers = {
    team: async ({ reply }) => reply('team ok'),
  };
  const commands = createContractCommands({
    orchestrator: {
      execute: async (_chatId, _body, opts) => {
        opts?.onProgress?.({ message: 'step-1' });
        return { output: 'done', strategy: 'auto', duration: 1500 };
      }
    },
    superAgentHandlers: handlers,
    pluginManager: { formatPluginList: () => '*plugins*' },
    executeBashAction: async (cmd) => ({ success: true, output: `ran:${cmd}` }),
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      return { result: { message_id: 42 } };
    },
    tgApi: async (method, body) => { tgCalls.push({ method, body }); return { ok: true }; },
  });

  return { commands, sent, tgCalls };
}

test('/orchestrate contract', async () => {
  const { commands, sent, tgCalls } = createHarness();
  const handled = await commands.handleOrchestrate(1, 'do stuff');
  assert.equal(handled, true);
  assert.match(sent[0].text, /Analyzing task/);
  assert.match(sent[sent.length - 1].text, /done/);
  assert.equal(tgCalls[0].method, 'editMessageText');
});

test('/team contract', async () => {
  const { commands, sent } = createHarness();
  const handled = await commands.handleTeam(1, '/team status');
  assert.equal(handled, true);
  assert.equal(sent.at(-1).text, 'team ok');
});

test('/plugins contract', async () => {
  const { commands, sent } = createHarness();
  const handled = await commands.handlePlugins(1);
  assert.equal(handled, true);
  assert.equal(sent.at(-1).text, '*plugins*');
});

test('/bash contract', async () => {
  const { commands, sent } = createHarness();
  const handled = await commands.handleBash(1, '/bash ls -la', '/tmp');
  assert.equal(handled, true);
  assert.equal(sent.at(-1).text, 'ran:ls -la');
});
