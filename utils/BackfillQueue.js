const MAX_ACTIVE_BACKFILLS = 1;

const guildQueues = new Map();

function getQueue(guildId) {
  const key = String(guildId ?? "unknown");
  let queue = guildQueues.get(key);
  if (!queue) {
    queue = { active: 0, items: [] };
    guildQueues.set(key, queue);
  }
  return { key, queue };
}

function pump(key, queue) {
  while (queue.active < MAX_ACTIVE_BACKFILLS && queue.items.length > 0) {
    const item = queue.items.shift();
    queue.active++;
    (async () => {
      try {
        item.resolve(await item.task());
      } catch (e) {
        item.reject(e);
      } finally {
        queue.active--;
        if (queue.active === 0 && queue.items.length === 0) {
          if (guildQueues.get(key) === queue) guildQueues.delete(key);
        } else {
          pump(key, queue);
        }
      }
    })();
  }
}

export function runBackfill(guildId, task) {
  const { key, queue } = getQueue(guildId);
  return new Promise((resolve, reject) => {
    queue.items.push({ task, resolve, reject });
    pump(key, queue);
  });
}

export function pendingBackfills(guildId) {
  return guildQueues.get(String(guildId ?? "unknown"))?.items.length ?? 0;
}
