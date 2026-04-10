function createTaskManager() {
  const activeTasks = new Map();
  const backgroundTasks = new Map();

  function getOrCreateActiveTaskMap(chatId) {
    if (!activeTasks.has(chatId)) activeTasks.set(chatId, new Map());
    return activeTasks.get(chatId);
  }

  function getOrCreateBackgroundTaskMap(chatId) {
    if (!backgroundTasks.has(chatId)) backgroundTasks.set(chatId, new Map());
    return backgroundTasks.get(chatId);
  }

  function pruneEmpty() {
    for (const [chatId, tasks] of activeTasks) {
      if (!tasks || tasks.size === 0) activeTasks.delete(chatId);
    }
    for (const [chatId, tasks] of backgroundTasks) {
      if (!tasks || tasks.size === 0) backgroundTasks.delete(chatId);
    }
  }

  return {
    activeTasks,
    backgroundTasks,
    getOrCreateActiveTaskMap,
    getOrCreateBackgroundTaskMap,
    pruneEmpty,
  };
}

module.exports = { createTaskManager };
