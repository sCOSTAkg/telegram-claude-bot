function createUpdateLoop({ processUpdateImpl, tgApi, getOffset, setOffset }) {
  async function processUpdate(update) {
    return processUpdateImpl(update);
  }

  async function tick() {
    const offset = getOffset();
    const data = await tgApi('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: ['message', 'callback_query']
    }, 45000);

    if (!data?.ok || !Array.isArray(data.result)) return;
    for (const upd of data.result) {
      await processUpdate(upd);
      setOffset(upd.update_id + 1);
    }
  }

  return { processUpdate, tick };
}

module.exports = { createUpdateLoop };
