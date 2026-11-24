import { ChannelType as DiscordChannelType, Events as DiscordEvents, GatewayDispatchEvents } from "discord.js";
import { Op } from "sequelize";
import { Events as FluxerEvents } from "@fluxerjs/core";
import { log } from "./Logger.js";
import { MAX_REJOIN_ATTEMPTS, shouldScheduleRejoinAttempt } from "./voiceRejoinLimit.js";
import { spawnBridge, killBridge, hasRunner, onRunnerAvailable } from "./VoiceRunnerServer.js";
import { fluxerClients, getFluxerClient, defaultFluxerClient } from "./FluxerClients.js";
import { BridgeEndpoint, VoiceChannelMap } from "../db/index.js";
const sessions = new Map();
const pending = new Map();
const latestDiscordVoiceState = new Map();
const latestDiscordVoiceServer = new Map();
const latestFluxerVoiceServer = new Map();
const pendingRunnerRestarts = new Map();
const restartBackoff = new Map();
const pendingJoinWatchdogs = new Map();
const fluxerVoiceStates = new Map();
const fluxerChannelOccupancy = new Map();
const fluxerOnlySessions = new Map();
const fluxerOnlyPending = new Map();
const fluxerOnlyTimers = new Map();
const fluxerOnlyGiveUpUntil = new Map();
let _discordClient = null;
let _voicePool = [];
let _startupRecoveryScheduled = false;
let _recoveryArmed = false;
let _recoveryRunning = false;
let _fluxerOnlyRecoveryRunning = false;
let _reconcileTimer = null;
const RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const REJOIN_COOLDOWN_MS = 10 * 60_000;
function normalizeInstanceId(instanceId) {
  return instanceId || "default";
}
function fluxerClientFor(instanceId) {
  const id = normalizeInstanceId(instanceId);
  return getFluxerClient(id) ?? (id === "default" ? defaultFluxerClient ?? null : null);
}
function getFluxerServerKey(instanceId, guildId, channelId) {
  const key = `${normalizeInstanceId(instanceId)}:${guildId}`;
  return channelId ? `${key}:${channelId}` : key;
}
function getFluxerOccupancyKey(instanceId, guildId, channelId) {
  return `${normalizeInstanceId(instanceId)}:${guildId}:${channelId}`;
}
function getFluxerUserStateKey(instanceId, guildId, userId) {
  return `${normalizeInstanceId(instanceId)}:${guildId}:${userId}`;
}
function voiceTargetFromEndpoint(endpoint, discordGuildId, discordChannelId) {
  return {
    instanceId: normalizeInstanceId(endpoint.instanceId),
    fluxerGuildId: endpoint.guildId,
    fluxerChannelId: endpoint.channelId,
    discordGuildId,
    discordChannelId,
  };
}
async function findVoiceTargets(guildId, channelId) {
  if (!guildId || !channelId) return [];
  const targets = [];
  const discordEndpoints = await BridgeEndpoint.findAll({ where: { platform: "discord", channelId } });
  if (discordEndpoints.length > 0) {
    const groupIds = [...new Set(discordEndpoints.map(endpoint => endpoint.groupId))];
    const fluxerEndpoints = await BridgeEndpoint.findAll({
      where: { groupId: { [Op.in]: groupIds }, platform: "fluxer" },
    });
    const seen = new Set();
    for (const endpoint of fluxerEndpoints) {
      if (!endpoint.instanceId) continue;
      const key = `${endpoint.instanceId}:${endpoint.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(voiceTargetFromEndpoint(endpoint, discordEndpoints[0].guildId, discordEndpoints[0].channelId));
    }
  }
  if (targets.length === 0) {
    const rows = await VoiceChannelMap.findAll({ where: { discordGuildId: guildId, discordChannelId: channelId } });
    for (const row of rows) {
      targets.push({
        instanceId: normalizeInstanceId(row.fluxerInstanceId),
        fluxerGuildId: row.fluxerGuildId,
        fluxerChannelId: row.fluxerChannelId,
        discordGuildId: row.discordGuildId,
        discordChannelId: row.discordChannelId,
      });
    }
  }
  return targets;
}
async function findDiscordTargetForFluxer(instanceId, fluxerGuildId, fluxerChannelId) {
  if (!fluxerGuildId || !fluxerChannelId) return null;
  const endpoint = await BridgeEndpoint.findOne({
    where: { platform: "fluxer", instanceId: normalizeInstanceId(instanceId), channelId: fluxerChannelId },
  });
  if (endpoint) {
    const sibling = await BridgeEndpoint.findOne({ where: { groupId: endpoint.groupId, platform: "discord" } });
    if (sibling) return { discordGuildId: sibling.guildId, discordChannelId: sibling.channelId };
  }
  const row = await VoiceChannelMap.findOne({
    where: { fluxerInstanceId: normalizeInstanceId(instanceId), fluxerGuildId, fluxerChannelId },
  });
  if (!row) return null;
  return { discordGuildId: row.discordGuildId, discordChannelId: row.discordChannelId };
}
async function findFluxerVoiceSiblings(instanceId, fluxerGuildId, fluxerChannelId) {
  if (!fluxerGuildId || !fluxerChannelId) return [];
  const endpoint = await BridgeEndpoint.findOne({
    where: { platform: "fluxer", instanceId: normalizeInstanceId(instanceId), channelId: fluxerChannelId },
  });
  if (!endpoint) return [];
  const siblings = await BridgeEndpoint.findAll({ where: { groupId: endpoint.groupId, platform: "fluxer" } });
  const out = [];
  const seen = new Set();
  for (const sibling of siblings) {
    const siblingInstanceId = normalizeInstanceId(sibling.instanceId);
    if (siblingInstanceId === normalizeInstanceId(instanceId) && sibling.channelId === fluxerChannelId) continue;
    const key = `${siblingInstanceId}:${sibling.guildId}:${sibling.channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      instanceId: siblingInstanceId,
      fluxerGuildId: sibling.guildId,
      fluxerChannelId: sibling.channelId,
    });
  }
  return out;
}
function fluxerOnlyTargetKey(target) {
  return `${normalizeInstanceId(target.instanceId)}:${target.fluxerGuildId}:${target.fluxerChannelId}`;
}
function fluxerOnlySessionKey(targets) {
  return `fluxer-only:${targets.map(fluxerOnlyTargetKey).sort().join("|")}`;
}
function getFluxerLivekitServer(target) {
  return (
    latestFluxerVoiceServer.get(
      getFluxerServerKey(target.instanceId, target.fluxerGuildId, target.fluxerChannelId)
    ) ??
    latestFluxerVoiceServer.get(getFluxerServerKey(target.instanceId, target.fluxerGuildId)) ??
    null
  );
}
function joinFluxerVoice(target) {
  fluxerClientFor(target.instanceId)?.sendToGateway(0, {
    op: 4,
    d: {
      guild_id: target.fluxerGuildId,
      channel_id: target.fluxerChannelId,
      self_mute: false,
      self_deaf: false,
    },
  });
}
function leaveFluxerVoice(targets) {
  for (const target of targets ?? []) {
    log("VOICE", `Leaving voice for fluxer=${target.instanceId}/${target.fluxerGuildId}`);
    fluxerClientFor(target.instanceId)?.sendToGateway(0, {
      op: 4,
      d: {
        guild_id: target.fluxerGuildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      },
    });
  }
}
function stopFluxerOnlySession(key) {
  const session = fluxerOnlySessions.get(key);
  if (session?.stopping) return;
  if (session) session.stopping = true;
  fluxerOnlySessions.delete(key);
  killBridge(key);
  leaveFluxerVoice(session?.targets);
  log("VOICE", `Fluxer-only voice session stopped (${key})`);
}
async function maybeLaunchFluxerOnly(key) {
  if (fluxerOnlySessions.has(key)) return;
  const pendingEntry = fluxerOnlyPending.get(key);
  if (!pendingEntry) return;
  const ready = [];
  const missing = [];
  for (const target of pendingEntry.targets) {
    const server = getFluxerLivekitServer(target);
    if (server?.livekitUrl && server?.livekitToken) ready.push({ target, server });
    else missing.push(target);
  }
  if (missing.length > 0) {
    if (Date.now() - (pendingEntry.armedAt ?? 0) > 15_000) {
      pendingEntry.attempts = (pendingEntry.attempts ?? 0) + 1;
      if (pendingEntry.attempts > 6) {
        log("VOICE", `Giving up on Fluxer voice credentials for ${key} after ${pendingEntry.attempts} attempts`);
        fluxerOnlyGiveUpUntil.set(key, Date.now() + 10 * 60_000);
        fluxerOnlyPending.delete(key);
        return;
      }
      log("VOICE", `Re-requesting Fluxer voice credentials for ${key} (attempt ${pendingEntry.attempts})`);
      for (const target of pendingEntry.targets) joinFluxerVoice(target);
      pendingEntry.armedAt = Date.now();
      fluxerOnlyPending.set(key, pendingEntry);
    }
    log(
      "VOICE",
      `Waiting on Fluxer voice credentials for ${key} (missing ${missing.map(fluxerOnlyTargetKey).join(",")})`
    );
    return;
  }
  if (!hasRunner()) {
    log("VOICE", `No runner available for Fluxer-only bridge ${key}`);
    return;
  }
  fluxerOnlyPending.delete(key);
  const livekitRooms = ready.map(({ target, server }) => ({
    url: server.livekitUrl,
    token: server.livekitToken,
    instanceId: target.instanceId,
    channelId: target.fluxerChannelId,
  }));
  const primary = ready[0];
  const sessionTargets = ready.map(({ target }) => target);
  log("VOICE", `Spawning Fluxer-only bridge ${key} (${livekitRooms.length} rooms)`);
  const spawned = spawnBridge(
    key,
    primary.server.livekitUrl,
    {
      FLUXER_ONLY: "1",
      LIVEKIT_URL: primary.server.livekitUrl,
      LIVEKIT_TOKEN: primary.server.livekitToken,
      LIVEKIT_ROOMS: JSON.stringify(livekitRooms),
    },
    {
      onMessage(msg) {
        const session = fluxerOnlySessions.get(key);
        if (!session) return;
        if (msg === "bridge-ready" || msg === "fluxer-joined") {
          session.empty = false;
        } else if (msg === "fluxer-empty") {
          session.empty = true;
          stopFluxerOnlySession(key);
        }
      },
      onExit(code) {
        log("VOICE", `Fluxer-only bridge exited (${key}, code ${code})`);
        const session = fluxerOnlySessions.get(key);
        fluxerOnlySessions.delete(key);
        const exitTargets = session?.targets ?? sessionTargets;
        if (code === 6 || code === 7) {
          for (const target of exitTargets) {
            latestFluxerVoiceServer.delete(
              getFluxerServerKey(target.instanceId, target.fluxerGuildId, target.fluxerChannelId)
            );
            latestFluxerVoiceServer.delete(getFluxerServerKey(target.instanceId, target.fluxerGuildId));
          }
        }
        leaveFluxerVoice(exitTargets);
        if (code === 0) return;
        if (getFluxerTargetCount(exitTargets) > 0) {
          armFluxerOnlyBridge(exitTargets, `bridge failure code ${code}`, 5000);
        }
      },
      onError(message) {
        log("VOICE", `Fluxer-only bridge error: ${message}`);
      },
    }
  );
  if (spawned) {
    fluxerOnlySessions.set(key, {
      targets: sessionTargets,
      empty: false,
      stopping: false,
    });
  } else {
    fluxerOnlyPending.set(key, { targets: sessionTargets, armedAt: Date.now(), attempts: 0 });
  }
}
function armFluxerOnlyBridge(targets, reason, delayMs = 0) {
  const unique = [];
  const seen = new Set();
  for (const target of targets ?? []) {
    const key = fluxerOnlyTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      instanceId: normalizeInstanceId(target.instanceId),
      fluxerGuildId: target.fluxerGuildId,
      fluxerChannelId: target.fluxerChannelId,
    });
  }
  if (unique.length < 2) return;
  const communities = new Set(unique.map(target => `${target.instanceId}:${target.fluxerGuildId}`));
  if (communities.size !== unique.length) {
    log(
      "VOICE",
      "Cannot bridge voice channels in the same community without a second bot connection; skipping Fluxer-only bridge"
    );
    return;
  }
  const key = fluxerOnlySessionKey(unique);
  if ((fluxerOnlyGiveUpUntil.get(key) ?? 0) > Date.now()) return;
  if (fluxerOnlySessions.has(key) || fluxerOnlyPending.has(key) || fluxerOnlyTimers.has(key)) return;
  const launch = async () => {
    fluxerOnlyTimers.delete(key);
    if (fluxerOnlySessions.has(key)) return;
    if (getFluxerTargetCount(unique) === 0) return;
    log("VOICE", `Arming Fluxer-only voice bridge ${key} (${reason})`);
    for (const target of unique) joinFluxerVoice(target);
    fluxerOnlyPending.set(key, { targets: unique, armedAt: Date.now(), attempts: 0 });
    await maybeLaunchFluxerOnly(key);
  };
  if (delayMs > 0) {
    fluxerOnlyTimers.set(key, setTimeout(() => void launch(), delayMs));
  } else {
    void launch();
  }
}
async function recoverFluxerOnlyBridges(reason) {
  if (_fluxerOnlyRecoveryRunning) return;
  _fluxerOnlyRecoveryRunning = true;
  try {
    for (const key of [...fluxerOnlyPending.keys()]) {
      await maybeLaunchFluxerOnly(key);
    }
    const fluxerEndpoints = await BridgeEndpoint.findAll({ where: { platform: "fluxer" } });
    const byGroup = new Map();
    for (const endpoint of fluxerEndpoints) {
      if (!endpoint.instanceId) continue;
      let list = byGroup.get(endpoint.groupId);
      if (!list) {
        list = [];
        byGroup.set(endpoint.groupId, list);
      }
      list.push(endpoint);
    }
    const candidateGroups = [...byGroup]
      .filter(([, list]) => list.length >= 2)
      .map(([groupId]) => groupId);
    if (candidateGroups.length === 0) return;
    const discordEndpoints = await BridgeEndpoint.findAll({
      where: { platform: "discord", groupId: { [Op.in]: candidateGroups } },
    });
    const groupsWithDiscord = new Set(discordEndpoints.map(endpoint => endpoint.groupId));
    for (const [groupId, list] of byGroup) {
      if (list.length < 2 || groupsWithDiscord.has(groupId)) continue;
      const targets = list.map(endpoint => ({
        instanceId: normalizeInstanceId(endpoint.instanceId),
        fluxerGuildId: endpoint.guildId,
        fluxerChannelId: endpoint.channelId,
      }));
      if (getFluxerTargetCount(targets) === 0) continue;
      armFluxerOnlyBridge(targets, reason);
    }
  } finally {
    _fluxerOnlyRecoveryRunning = false;
  }
}
async function findVoiceMapChannels() {
  const channels = new Map();
  const discordEndpoints = await BridgeEndpoint.findAll({ where: { platform: "discord" } });
  for (const endpoint of discordEndpoints) {
    const guild = _discordClient?.guilds.cache.get(endpoint.guildId);
    const channel = guild?.channels.cache.get(endpoint.channelId);
    if (channel?.type !== DiscordChannelType.GuildVoice) continue;
    channels.set(endpoint.channelId, endpoint.guildId);
  }
  const rows = await VoiceChannelMap.findAll();
  for (const row of rows) {
    if (!channels.has(row.discordChannelId)) channels.set(row.discordChannelId, row.discordGuildId);
  }
  return [...channels].map(([channelId, guildId]) => ({ channelId, guildId }));
}
function getSessionTargets(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.targets)) return entry.targets;
  if (entry.fluxerGuildId) {
    return [
      {
        instanceId: normalizeInstanceId(entry.fluxerInstanceId),
        fluxerGuildId: entry.fluxerGuildId,
        fluxerChannelId: entry.fluxerChannelId,
      },
    ];
  }
  return [];
}
function checkAndMaybeStop(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;
  const guild = _discordClient?.guilds.cache.get(session.guildId);
  const discordChannel = guild?.channels.cache.get(channelId);
  const discordCount = discordChannel?.members?.filter(m => !m.user.bot).size ?? 0;
  if (discordCount === 0 && session.fluxerEmpty) {
    stopSession(channelId);
  }
}
function findSessionChannelsByGuild(guildId) {
  const out = [];
  for (const [channelId, session] of sessions) {
    if (session.guildId === guildId) out.push(channelId);
  }
  return out;
}
function allVoiceClients() {
  const out = [];
  if (_discordClient) out.push(_discordClient);
  for (const c of _voicePool) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
function getClientUserId(client) {
  return client.user?.id ?? null;
}
function getDiscordStateKey(userId, guildId) {
  return `${userId ?? "?"}:${guildId}`;
}
function pickVoiceClient(guildId, channelId) {
  for (const client of allVoiceClients()) {
    if (!getClientUserId(client)) continue;
    let busy = false;
    for (const [otherChannelId, session] of sessions) {
      if (otherChannelId !== channelId && session.guildId === guildId && session.voiceClient === client) {
        busy = true;
        break;
      }
    }
    if (busy) continue;
    for (const [otherChannelId, creds] of pending) {
      if (otherChannelId !== channelId && creds.guildId === guildId && creds.voiceClient === client) {
        busy = true;
        break;
      }
    }
    if (!busy) return client;
  }
  return null;
}
function getDiscordHumanCount(guildId, channelId) {
  const guild = _discordClient?.guilds.cache.get(guildId);
  const discordChannel = guild?.channels.cache.get(channelId);
  return discordChannel?.members?.filter(m => !m.user.bot).size ?? 0;
}
function getFluxerHumanCount(instanceId, guildId, channelId) {
  return fluxerChannelOccupancy.get(getFluxerOccupancyKey(instanceId, guildId, channelId)) ?? 0;
}
function adjustFluxerOccupancy(instanceId, guildId, channelId, delta) {
  const key = getFluxerOccupancyKey(instanceId, guildId, channelId);
  const next = (fluxerChannelOccupancy.get(key) ?? 0) + delta;
  if (next > 0) {
    fluxerChannelOccupancy.set(key, next);
  } else {
    fluxerChannelOccupancy.delete(key);
  }
}
function updateFluxerVoiceState(instanceId, guildId, userId, channelId) {
  const userKey = getFluxerUserStateKey(instanceId, guildId, userId);
  const previousChannelId = fluxerVoiceStates.get(userKey);
  if (previousChannelId) {
    adjustFluxerOccupancy(instanceId, guildId, previousChannelId, -1);
    fluxerVoiceStates.delete(userKey);
  }
  if (channelId) {
    fluxerVoiceStates.set(userKey, channelId);
    adjustFluxerOccupancy(instanceId, guildId, channelId, 1);
  }
}
function clearRestartBackoff(channelId) {
  const state = restartBackoff.get(channelId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
  }
  restartBackoff.delete(channelId);
}
function clearPendingJoinWatchdog(channelId) {
  const timer = pendingJoinWatchdogs.get(channelId);
  if (!timer) return;
  clearTimeout(timer);
  pendingJoinWatchdogs.delete(channelId);
}
function scheduleSessionRejoin(channelId, guildId, options) {
  const existing = restartBackoff.get(channelId);
  if (existing?.timer) {
    log("VOICE", `Rejoin already scheduled for channel ${channelId}; keeping existing backoff`);
    return;
  }
  const attempt = (existing?.attempt ?? 0) + 1;
  if (!shouldScheduleRejoinAttempt(attempt)) {
    restartBackoff.set(channelId, { attempt: 0, timer: null, cooldownUntil: Date.now() + REJOIN_COOLDOWN_MS });
    log(
      "VOICE",
      `Not rejoining channel ${channelId}; reached max attempts (${MAX_REJOIN_ATTEMPTS}) after ${options.reason}, cooling down ${REJOIN_COOLDOWN_MS / 60_000} minutes`
    );
    return;
  }
  const delay = RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)];
  log("VOICE", `Scheduling rejoin for channel ${channelId} in ${delay}ms (${options.reason}, attempt ${attempt})`);
  const timer = setTimeout(() => {
    const state = restartBackoff.get(channelId);
    if (!state || state.timer !== timer) return;
    restartBackoff.set(channelId, { attempt: state.attempt, timer: null });
    void rejoinMappedChannel(guildId, channelId, {
      allowWithoutDiscord: options.allowWithoutDiscord,
      requireFreshDiscord: options.requireFreshDiscord,
    });
  }, delay);
  restartBackoff.set(channelId, { attempt, timer });
}
function clearPendingChannel(channelId) {
  clearPendingJoinWatchdog(channelId);
  pending.delete(channelId);
}
function clearPendingForDiscordGuild(guildId, keepChannelId, onlyClient) {
  for (const [channelId, creds] of pending) {
    if (creds.guildId !== guildId || channelId === keepChannelId) continue;
    if (onlyClient && creds.voiceClient !== onlyClient) continue;
    clearPendingJoinWatchdog(channelId);
    pending.delete(channelId);
  }
}
function clearPendingForFluxerChannel(fluxerInstanceId, fluxerGuildId, fluxerChannelId, keepChannelId) {
  const instanceId = normalizeInstanceId(fluxerInstanceId);
  for (const [channelId, creds] of pending) {
    if (channelId === keepChannelId) continue;
    const matches = getSessionTargets(creds).some(
      target =>
        target.instanceId === instanceId &&
        target.fluxerGuildId === fluxerGuildId &&
        target.fluxerChannelId === fluxerChannelId
    );
    if (!matches) continue;
    clearPendingJoinWatchdog(channelId);
    pending.delete(channelId);
  }
}
function getPendingChannelForGuild(guildId, channelId) {
  const creds = pending.get(channelId);
  if (!creds || creds.guildId !== guildId) return null;
  return creds;
}
function hasPendingChannelForGuild(guildId) {
  for (const creds of pending.values()) {
    if (creds.guildId === guildId) return true;
  }
  return false;
}
function bumpDiscordVoiceServerGeneration(voiceClient, guildId) {
  const userId = getClientUserId(voiceClient);
  const key = getDiscordStateKey(userId, guildId);
  const current = latestDiscordVoiceServer.get(key);
  const generation = (current?.generation ?? 0) + 1;
  latestDiscordVoiceServer.set(key, {
    endpoint: current?.endpoint,
    token: current?.token,
    generation,
  });
  return generation;
}
function isFluxerGuildInUse(fluxerInstanceId, fluxerGuildId, exceptChannelId) {
  const instanceId = normalizeInstanceId(fluxerInstanceId);
  for (const [id, entry] of [...sessions, ...pending]) {
    if (id === exceptChannelId) continue;
    for (const target of getSessionTargets(entry)) {
      if (target.instanceId === instanceId && target.fluxerGuildId === fluxerGuildId) return true;
    }
  }
  return false;
}
function sendLeaveOps(voiceClient, guildId, targets, leaveDiscord = true, exceptChannelId) {
  const guild = voiceClient?.guilds.cache.get(guildId) ?? _discordClient?.guilds.cache.get(guildId);
  if (leaveDiscord) {
    guild?.shard.send({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      },
    });
  }
  for (const target of targets ?? []) {
    log("VOICE", `Leaving voice for discord=${guildId} fluxer=${target.instanceId}/${target.fluxerGuildId}`);
    if (isFluxerGuildInUse(target.instanceId, target.fluxerGuildId, exceptChannelId)) {
      log("VOICE", `Keeping Fluxer voice for ${target.instanceId}/${target.fluxerGuildId}; another bridge still uses it`);
      continue;
    }
    fluxerClientFor(target.instanceId)?.sendToGateway(0, {
      op: 4,
      d: {
        guild_id: target.fluxerGuildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      },
    });
  }
}
function getFluxerTargetCount(targets) {
  return (targets ?? []).reduce(
    (sum, target) => sum + getFluxerHumanCount(target.instanceId, target.fluxerGuildId, target.fluxerChannelId),
    0
  );
}
function requestSessionRestart(channelId, reason) {
  const session = sessions.get(channelId);
  if (!session || session.stopping || session.restartRequested) return;
  session.restartRequested = true;
  log("VOICE", `Restarting session for channel ${channelId}: ${reason}`);
  killBridge(channelId);
}
async function flushPendingRunnerRestarts() {
  if (!_discordClient || !hasRunner() || pendingRunnerRestarts.size === 0) return;
  for (const [channelId, { guildId }] of [...pendingRunnerRestarts]) {
    await rejoinMappedChannel(guildId, channelId, { requireFreshDiscord: true });
    pendingRunnerRestarts.delete(channelId);
  }
}
async function recoverActiveVoiceBridges(reason) {
  if (!_discordClient || !_recoveryArmed || !hasRunner()) return;
  if (fluxerClients.size === 0 && !defaultFluxerClient) return;
  if (_recoveryRunning) return;
  _recoveryRunning = true;
  try {
    const channels = await findVoiceMapChannels();
    for (const { channelId, guildId } of channels) {
      const backoff = restartBackoff.get(channelId);
      if (
        sessions.has(channelId) ||
        pending.has(channelId) ||
        pendingRunnerRestarts.has(channelId) ||
        backoff?.timer ||
        (backoff?.cooldownUntil ?? 0) > Date.now()
      )
        continue;
      const targets = await findVoiceTargets(guildId, channelId);
      const configured = targets.filter(target => fluxerClientFor(target.instanceId));
      if (configured.length === 0) {
        log("VOICE", `Skipping recovery for ${channelId}; no configured Fluxer voice targets`);
        continue;
      }
      const discordCount = getDiscordHumanCount(guildId, channelId);
      const fluxerCount = getFluxerTargetCount(configured);
      if (discordCount === 0 && fluxerCount === 0) continue;
      log(
        "VOICE",
        `Recovering mapped VC ${channelId} after ${reason} (discord=${discordCount}, fluxer=${configured
          .map(target => target.instanceId)
          .join(",")}=${fluxerCount})`
      );
      await rejoinMappedChannel(guildId, channelId, {
        allowWithoutDiscord: fluxerCount > 0,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } finally {
    _recoveryRunning = false;
  }
}
function scheduleStartupRecovery(reason) {
  if (_startupRecoveryScheduled) return;
  _startupRecoveryScheduled = true;
  queueMicrotask(async () => {
    _startupRecoveryScheduled = false;
    await flushPendingRunnerRestarts();
    await recoverActiveVoiceBridges(reason);
    await recoverFluxerOnlyBridges(reason);
  });
}
async function rejoinMappedChannel(guildId, channelId, options = {}) {
  if (!_discordClient) return;
  if (sessions.has(channelId) || pending.has(channelId)) {
    log("VOICE", `Skipping rejoin for channel ${channelId}; recovery is already in progress`);
    return;
  }
  if (!options.allowWithoutDiscord && getDiscordHumanCount(guildId, channelId) === 0) {
    log("VOICE", `Skipping rejoin for channel ${channelId}; no Discord users remain`);
    return;
  }
  log("VOICE", `Rejoining Discord VC ${channelId}`);
  await sendJoinOp(guildId, channelId, {
    requireFreshDiscord: options.requireFreshDiscord,
  });
}
export async function setupVoiceHandling(discordClient, extraVoiceClients = []) {
  _discordClient = discordClient;
  _voicePool = (extraVoiceClients ?? []).filter(Boolean);
  onRunnerAvailable(() => {
    scheduleStartupRecovery("runner availability");
  });
  const voiceChannels = await findVoiceMapChannels();
  log(
    "VOICE",
    `Loaded ${voiceChannels.length} voice channel(s) across ${allVoiceClients().length} discord client(s) and ${fluxerClients.size} Fluxer instance(s)`
  );
  function attachDiscordVoiceGateway(voiceClient) {
    voiceClient.ws.on(GatewayDispatchEvents.VoiceStateUpdate, async data => {
      const ownerId = voiceClient.user?.id;
      if (!ownerId || data.user_id !== ownerId) return;
      const { guild_id: guildId, channel_id: channelId, session_id: sessionId } = data;
      const stateKey = getDiscordStateKey(ownerId, guildId);
      log(
        "VOICE",
        `Discord gateway VoiceStateUpdate bot=${ownerId} guild=${guildId} channel=${channelId ?? "null"} session=${sessionId ?? "null"}`
      );
      if (channelId) {
        latestDiscordVoiceState.set(stateKey, { channelId, sessionId });
        const creds = getPendingChannelForGuild(guildId, channelId);
        if (creds && creds.voiceClient === voiceClient) {
          creds.sessionId = sessionId;
          pending.set(channelId, creds);
          log("VOICE", `Got Discord session for ${channelId}`);
          await maybeLaunch(channelId);
        }
      } else {
        if (hasPendingChannelForGuild(guildId)) {
          log("VOICE", `Ignoring Discord disconnect for guild ${guildId}; rejoin already pending`);
          return;
        }
        latestDiscordVoiceState.delete(stateKey);
        log("VOICE", `Clearing pending credentials for guild ${guildId} after disconnect`);
        clearPendingForDiscordGuild(guildId, undefined, voiceClient);
        const activeChannelIds = findSessionChannelsByGuild(guildId).filter(id => sessions.get(id)?.voiceClient === voiceClient);
        for (const activeChannelId of activeChannelIds) {
          requestSessionRestart(activeChannelId, "Discord bot voice state disconnected");
        }
      }
    });
    voiceClient.ws.on(GatewayDispatchEvents.VoiceServerUpdate, async data => {
      const ownerId = voiceClient.user?.id;
      if (!ownerId) return;
      const { guild_id: guildId, endpoint, token } = data;
      let relevant = false;
      for (const creds of pending.values()) {
        if (creds.voiceClient === voiceClient && creds.guildId === guildId) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;
      const stateKey = getDiscordStateKey(ownerId, guildId);
      log("VOICE", `Discord gateway VoiceServerUpdate bot=${ownerId} guild=${guildId} endpoint=${endpoint ?? "null"}`);
      const current = latestDiscordVoiceServer.get(stateKey);
      const generation = current?.generation ?? 0;
      latestDiscordVoiceServer.set(stateKey, { endpoint, token, generation });
      for (const [channelId, creds] of pending) {
        if (creds.voiceClient !== voiceClient) continue;
        if (creds.guildId !== guildId) continue;
        if (creds.discordVoiceServerGeneration !== generation) continue;
        creds.endpoint = endpoint;
        creds.token = token;
        pending.set(channelId, creds);
        log("VOICE", `Got Discord voice server for ${channelId}`);
        await maybeLaunch(channelId);
      }
    });
  }
  for (const voiceClient of allVoiceClients()) {
    attachDiscordVoiceGateway(voiceClient);
  }
  for (const [instanceId, fluxerClient] of fluxerClients) {
    fluxerClient.on(FluxerEvents.Ready, () => {
      scheduleStartupRecovery(`Fluxer ready (${instanceId})`);
    });
    fluxerClient.on(FluxerEvents.VoiceServerUpdate, async data => {
      const { guild_id: fluxerGuildId, channel_id: fluxerChannelId, endpoint: livekitUrl, token: livekitToken } = data;
      if (!fluxerGuildId || !livekitUrl || !livekitToken) return;
      latestFluxerVoiceServer.set(getFluxerServerKey(instanceId, fluxerGuildId, fluxerChannelId), {
        livekitUrl,
        livekitToken,
      });
      for (const [channelId, creds] of pending) {
        let matched = false;
        for (const target of creds.targets ?? []) {
          if (target.instanceId !== instanceId) continue;
          if (target.fluxerGuildId !== fluxerGuildId) continue;
          if (fluxerChannelId && target.fluxerChannelId !== fluxerChannelId) continue;
          target.livekitUrl = livekitUrl;
          target.livekitToken = livekitToken;
          matched = true;
        }
        if (!matched) continue;
        pending.set(channelId, creds);
        log("VOICE", `Got Fluxer voice server for ${channelId} (${instanceId})`);
        await maybeLaunch(channelId);
      }
      for (const [key, entry] of [...fluxerOnlyPending]) {
        const relevant = entry.targets.some(
          target =>
            target.instanceId === instanceId &&
            target.fluxerGuildId === fluxerGuildId &&
            (!fluxerChannelId || target.fluxerChannelId === fluxerChannelId)
        );
        if (!relevant) continue;
        await maybeLaunchFluxerOnly(key);
      }
    });
    fluxerClient.on(FluxerEvents.VoiceStatesSync, data => {
      for (const state of data.voiceStates) {
        if (state.user_id === fluxerClient.user?.id) continue;
        if (state.member?.user?.bot) continue;
        updateFluxerVoiceState(instanceId, data.guildId, state.user_id, state.channel_id);
      }
      if (_recoveryArmed) {
        scheduleStartupRecovery(`Fluxer voice sync for guild ${data.guildId} (${instanceId})`);
      }
    });
    fluxerClient.on("voiceStateUpdate", async data => {
      if (!data.guild_id) return;
      if (data.user_id !== fluxerClient.user?.id && !data.member?.user?.bot) {
        updateFluxerVoiceState(instanceId, data.guild_id, data.user_id, data.channel_id);
      }
      if (!data.channel_id) return;
      if (data.user_id === fluxerClient.user?.id) return;
      if (data.member?.user?.bot) return;
      log(
        "VOICE",
        `Fluxer voiceStateUpdate (${instanceId}) guild=${data.guild_id} channel=${data.channel_id} user=${data.user_id}`
      );
      const discordTarget = await findDiscordTargetForFluxer(instanceId, data.guild_id, data.channel_id);
      if (!discordTarget) {
        const siblings = await findFluxerVoiceSiblings(instanceId, data.guild_id, data.channel_id);
        if (siblings.length === 0) {
          log(
            "VOICE",
            `Fluxer voiceStateUpdate (${instanceId}) had no configured map for guild=${data.guild_id} channel=${data.channel_id}`
          );
          return;
        }
        const targets = [
          {
            instanceId: normalizeInstanceId(instanceId),
            fluxerGuildId: data.guild_id,
            fluxerChannelId: data.channel_id,
          },
          ...siblings,
        ];
        log("VOICE", `Fluxer-to-Fluxer voice join detected (${instanceId}); arming voice bridge`);
        armFluxerOnlyBridge(targets, "Fluxer join detected");
        return;
      }
      if (sessions.has(discordTarget.discordChannelId)) return;
      log(
        "VOICE",
        `Mapped Fluxer join detected (${instanceId}); requesting Discord join for channel ${discordTarget.discordChannelId}`
      );
      await sendJoinOp(discordTarget.discordGuildId, discordTarget.discordChannelId);
    });
  }
  discordClient.on(DiscordEvents.VoiceStateUpdate, async (oldState, newState) => {
    if (newState.member?.user?.bot) return;
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const joinedId = newState.channelId;
    const leftId = oldState.channelId;
    if (joinedId || leftId) {
      log(
        "VOICE",
        `User voice state guild=${guildId} user=${newState.member?.user?.id ?? oldState.member?.user?.id ?? "unknown"} joined=${joinedId ?? "null"} left=${leftId ?? "null"}`
      );
    }
    if (joinedId && !sessions.has(joinedId) && (await findVoiceTargets(guildId, joinedId)).length > 0) {
      log("VOICE", `Mapped Discord join detected for guild=${guildId} channel=${joinedId}`);
      await sendJoinOp(guildId, joinedId);
    }
    if (leftId && leftId !== joinedId && sessions.has(leftId)) {
      checkAndMaybeStop(leftId);
    }
  });
}
export function startVoiceRecovery() {
  if (_recoveryArmed) return;
  _recoveryArmed = true;
  scheduleStartupRecovery("startup complete");
  _reconcileTimer ??= setInterval(() => {
    void recoverActiveVoiceBridges("periodic reconcile");
    void recoverFluxerOnlyBridges("periodic reconcile");
  }, 60_000);
}
async function sendJoinOp(guildId, channelId, options = {}) {
  if (!guildId || !channelId) return;
  const targets = (await findVoiceTargets(guildId, channelId)).filter(target => fluxerClientFor(target.instanceId));
  if (targets.length === 0) {
    log("VOICE", `sendJoinOp ignored; no map for guild=${guildId} channel=${channelId}`);
    return;
  }
  const instanceList = [...new Set(targets.map(target => target.instanceId))].join(",");
  if (!hasRunner()) {
    log("VOICE", `No runner available, not joining VC ${channelId}`);
    return;
  }
  if (sessions.has(channelId) || pending.has(channelId)) {
    log("VOICE", `Join already in progress for channel ${channelId}; skipping duplicate request`);
    return;
  }
  const voiceClient = pickVoiceClient(guildId, channelId);
  if (!voiceClient) {
    log("VOICE", `No free Discord client for guild=${guildId} channel=${channelId}; add another token to DiscordVoiceTokens`);
    return;
  }
  const botUserId = getClientUserId(voiceClient);
  const guild = voiceClient.guilds.cache.get(guildId) ?? _discordClient?.guilds.cache.get(guildId) ?? null;
  log("VOICE", `Joining Discord VC ${channelId} with bot=${botUserId} (Fluxer ${instanceList})`);
  clearPendingForDiscordGuild(guildId, channelId, voiceClient);
  for (const target of targets) {
    clearPendingForFluxerChannel(target.instanceId, target.fluxerGuildId, target.fluxerChannelId, channelId);
  }
  const discordVoiceServerGeneration = bumpDiscordVoiceServerGeneration(voiceClient, guildId);
  const stateKey = getDiscordStateKey(botUserId, guildId);
  const discordState = latestDiscordVoiceState.get(stateKey);
  const discordServer = latestDiscordVoiceServer.get(stateKey);
  const requireFreshDiscord = options.requireFreshDiscord ?? false;
  for (const target of targets) {
    const fluxerServer =
      latestFluxerVoiceServer.get(getFluxerServerKey(target.instanceId, target.fluxerGuildId, target.fluxerChannelId)) ??
      latestFluxerVoiceServer.get(getFluxerServerKey(target.instanceId, target.fluxerGuildId));
    target.livekitUrl = fluxerServer?.livekitUrl;
    target.livekitToken = fluxerServer?.livekitToken;
  }
  log(
    "VOICE",
    `Preparing join for ${channelId}${requireFreshDiscord ? " with fresh Discord state" : ""} (Fluxer ${instanceList})`
  );
  pending.set(channelId, {
    guildId,
    channelId,
    voiceClient,
    targets,
    discordVoiceServerGeneration,
    sessionId: undefined,
    endpoint: requireFreshDiscord ? undefined : discordServer?.endpoint,
    token: requireFreshDiscord ? undefined : discordServer?.token,
  });
  clearPendingJoinWatchdog(channelId);
  const joinTimeoutMs = 45_000;
  const watchdog = setTimeout(() => {
    pendingJoinWatchdogs.delete(channelId);
    const stillPending = pending.get(channelId);
    if (!stillPending) return;
    log("VOICE", `Timed out waiting for voice credentials for ${channelId}`);
    clearPendingChannel(channelId);
    sendLeaveOps(voiceClient, guildId, stillPending.targets ?? targets, true, channelId);
    if (!stillPending.sessionId) {
      log(
        "VOICE",
        `Channel ${channelId} never produced a Discord voice session; bot likely lacks Connect permission there, cooling down ${REJOIN_COOLDOWN_MS / 60_000} minutes`
      );
      restartBackoff.set(channelId, { attempt: 0, timer: null, cooldownUntil: Date.now() + REJOIN_COOLDOWN_MS });
      return;
    }
    scheduleSessionRejoin(channelId, guildId, {
      allowWithoutDiscord: getFluxerTargetCount(targets) > 0,
      requireFreshDiscord: true,
      reason: "voice credentials timed out",
    });
  }, joinTimeoutMs);
  pendingJoinWatchdogs.set(channelId, watchdog);
  guild?.shard.send({
    op: 4,
    d: {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: false,
      self_deaf: false,
    },
  });
  for (const target of targets) {
    fluxerClientFor(target.instanceId)?.sendToGateway(0, {
      op: 4,
      d: {
        guild_id: target.fluxerGuildId,
        channel_id: target.fluxerChannelId,
        self_mute: false,
        self_deaf: false,
      },
    });
  }
  await maybeLaunch(channelId);
}
async function maybeLaunch(channelId) {
  const creds = pending.get(channelId);
  if (!creds) return;
  const { guildId, voiceClient, targets, sessionId, endpoint, token } = creds;
  const readyTargets = (targets ?? []).filter(target => target.livekitUrl && target.livekitToken);
  if (
    !sessionId ||
    !endpoint ||
    !token ||
    !channelId ||
    readyTargets.length === 0 ||
    readyTargets.length !== (targets?.length ?? 0)
  ) {
    const missing = (targets ?? [])
      .filter(target => !target.livekitUrl || !target.livekitToken)
      .map(target => `${target.instanceId}:${target.fluxerChannelId}`);
    log(
      "VOICE",
      `Waiting on voice state before spawning ${channelId} (missing ${missing.length > 0 ? missing.join(",") : "discord"})`
    );
    return;
  }
  if (sessions.has(channelId)) return;
  clearPendingChannel(channelId);
  const roomList = readyTargets.map(target => `${target.instanceId}:${target.fluxerChannelId}`).join(",");
  log("VOICE", `Spawning bridge for channel ${channelId} (Fluxer ${roomList})`);
  const primary = readyTargets[0];
  const livekitRooms = readyTargets.map(target => ({
    url: target.livekitUrl,
    token: target.livekitToken,
    instanceId: target.instanceId,
    channelId: target.fluxerChannelId,
  }));
  const spawned = spawnBridge(
    channelId,
    primary.livekitUrl,
    {
      DISCORD_ENDPOINT: endpoint,
      DISCORD_TOKEN: token,
      DISCORD_SESSION_ID: sessionId,
      DISCORD_USER_ID: voiceClient.user?.id ?? "",
      DISCORD_GUILD_ID: guildId,
      DISCORD_CHANNEL_ID: channelId,
      LIVEKIT_URL: primary.livekitUrl,
      LIVEKIT_TOKEN: primary.livekitToken,
      LIVEKIT_ROOMS: JSON.stringify(livekitRooms),
    },
    {
      onMessage(msg) {
        const session = sessions.get(channelId);
        if (!session) return;
        if (msg === "bridge-ready") {
          clearRestartBackoff(channelId);
          session.fluxerEmpty = false;
        } else if (msg === "fluxer-empty") {
          session.fluxerEmpty = true;
          checkAndMaybeStop(channelId);
        } else if (msg === "fluxer-joined") {
          session.fluxerEmpty = false;
        }
      },
      onExit(code) {
        log("VOICE", `Bridge exited (code ${code})`);
        const session = sessions.get(channelId);
        const restartRequested = session?.restartRequested ?? false;
        const exitTargets = session?.targets ?? readyTargets;
        const fluxerCount = getFluxerTargetCount(exitTargets);
        const requireFreshDiscord = true;
        {
          const botId = getClientUserId(voiceClient);
          latestDiscordVoiceServer.delete(getDiscordStateKey(botId, guildId));
          latestDiscordVoiceState.delete(getDiscordStateKey(botId, guildId));
        }
        if (code === 6 || code === 7) {
          for (const target of exitTargets) {
            latestFluxerVoiceServer.delete(getFluxerServerKey(target.instanceId, target.fluxerGuildId));
            latestFluxerVoiceServer.delete(
              getFluxerServerKey(target.instanceId, target.fluxerGuildId, target.fluxerChannelId)
            );
          }
        }
        sessions.delete(channelId);
        if (restartRequested) {
          sendLeaveOps(voiceClient, guildId, exitTargets, false, channelId);
          void rejoinMappedChannel(guildId, channelId, { requireFreshDiscord: true });
        } else if (typeof code === "number" && code !== 0) {
          sendLeaveOps(voiceClient, guildId, exitTargets, requireFreshDiscord, channelId);
          scheduleSessionRejoin(channelId, guildId, {
            allowWithoutDiscord: fluxerCount > 0,
            requireFreshDiscord,
            reason: `bridge failure code ${code}`,
          });
        } else if (code === null) {
          sendLeaveOps(voiceClient, guildId, exitTargets, false, channelId);
          pendingRunnerRestarts.set(channelId, { guildId });
          log("VOICE", `Queued rejoin for channel ${channelId} until a runner reconnects`);
        } else {
          sendLeaveOps(voiceClient, guildId, exitTargets, true, channelId);
        }
      },
      onError(message) {
        log("VOICE", `Bridge error: ${message}`);
      },
    }
  );
  if (spawned) {
    sessions.set(channelId, {
      guildId,
      voiceClient,
      targets: readyTargets,
      fluxerEmpty: false,
      stopping: false,
      restartRequested: false,
    });
  } else {
    pendingRunnerRestarts.set(channelId, { guildId });
  }
}
function stopSession(channelId) {
  const session = sessions.get(channelId);
  if (!session || session.stopping) return;
  session.stopping = true;
  killBridge(channelId);
  log("VOICE", `Session stopped for channel ${channelId}`);
}
