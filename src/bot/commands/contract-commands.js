function createContractCommands(deps) {
  const { orchestrator, superAgentHandlers, pluginManager, executeBashAction, send, tgApi } = deps;

  async function handleOrchestrate(chatId, cmdBody) {
    if (!cmdBody) {
      await send(chatId, 'Usage: /orchestrate <task description>');
      return true;
    }

    const statusMsg = await send(chatId, '[Orchestrator] Analyzing task...');
    const statusMsgId = statusMsg?.result?.message_id;
    try {
      const result = await orchestrator.execute(chatId, cmdBody, {
        onProgress: (u) => {
          if (!statusMsgId) return;
          tgApi('editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: u.message?.slice(0, 4000) || '...'
          }).catch(() => {});
        },
      });
      const output = result.output || result.error || 'No output';
      const header = `Strategy: ${result.strategy || 'auto'} | ${result.duration ? Math.round(result.duration / 1000) + 's' : ''}`;
      await send(chatId, `${header}\n\n${String(output).slice(0, 4000)}`);
    } catch (e) {
      await send(chatId, `Error: ${e.message}`);
    }
    return true;
  }

  async function handleTeam(chatId, text) {
    if (!superAgentHandlers) return false;
    const parts = text.split(/\s+/);
    const cmd = parts[0].slice(1).toLowerCase();
    const cmdList = ['team', 'agents', 'skills', 'reuse', 'team-status', 'task-history'];
    if (!cmdList.includes(cmd) || !superAgentHandlers[cmd]) return false;

    await superAgentHandlers[cmd]({
      from: { id: chatId },
      message: { text, message_id: null },
      reply: async (msg, opts) => send(chatId, msg, opts),
      deleteMessage: async () => {},
    });
    return true;
  }

  async function handlePlugins(chatId) {
    if (!pluginManager) return false;
    await send(chatId, pluginManager.formatPluginList(), { parse_mode: 'Markdown' });
    return true;
  }

  async function handleBash(chatId, text, workDir = '/tmp') {
    if (!text.startsWith('/bash')) return false;
    const cmd = text.replace(/^\/bash\s*/i, '').trim();
    if (!cmd) {
      await send(chatId, '❌ Укажите команду: /bash ls -la');
      return true;
    }
    const result = await executeBashAction(cmd, workDir);
    await send(chatId, result.output || 'No output');
    return true;
  }

  return {
    handleOrchestrate,
    handleTeam,
    handlePlugins,
    handleBash,
  };
}

module.exports = { createContractCommands };
