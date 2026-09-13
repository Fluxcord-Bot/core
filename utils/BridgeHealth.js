const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_THRESHOLD = 5;

/** @type {Map<string, number[]>} */
const failuresByGuild = new Map();

function pruneFailures(guildId) {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  const times = (failuresByGuild.get(guildId) ?? []).filter((t) => t > cutoff);
  if (times.length > 0) {
    failuresByGuild.set(guildId, times);
  } else {
    failuresByGuild.delete(guildId);
  }
}

export function recordBridgeFailure(guildId) {
  pruneFailures(guildId);
  failuresByGuild.set(guildId, [
    ...(failuresByGuild.get(guildId) ?? []),
    Date.now(),
  ]);
}

export function resetBridgeHealth(guildId) {
  failuresByGuild.delete(guildId);
}

export function isBridgeHealthDegraded(guildId) {
  pruneFailures(guildId);
  return (failuresByGuild.get(guildId) ?? []).length >= FAILURE_THRESHOLD;
}
