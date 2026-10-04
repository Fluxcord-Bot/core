import { Events as DiscordEvents, GatewayDispatchEvents } from "discord.js";
import { Events as FluxerEvents } from "@fluxerjs/core";
import { log } from "./Logger.js";
import { MAX_REJOIN_ATTEMPTS, shouldScheduleRejoinAttempt } from "./voiceRejoinLimit.js";
import {
  spawnBridge,
  killBridge,
  hasRunner,
  onRunnerAvailable,
} from "./VoiceRunnerServer.js";
import { VoiceChannelMap } from "../db/index.js";
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
let _discordClient = null;
let _voicePool = [];
let _fluxerClient = null;
let _startupRecoveryScheduled = false;
let _recoveryArmed = false;
const RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
function getFluxerOccupancyKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}
function getFluxerUserStateKey(guildId, userId) {
  return `${guildId}:${userId}`;
}
async function findVoiceMap(guildId, channelId) {
  if (!guildId || !channelId) return null;
  return  (VoiceChannelMap.findOne({
      where: { discordGuildId: guildId, discordChannelId: channelId },
    })
  );
}
async function findVoiceMapByFluxer(fluxerGuildId, fluxerChannelId) {
  if (!fluxerGuildId || !fluxerChannelId) return null;
  return  (VoiceChannelMap.findOne({
      where: { fluxerGuildId, fluxerChannelId },
    })
  );
}
function checkAndMaybeStop(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;
  const guild = _discordClient?.guilds.cache.get(session.guildId);
  const discordChannel =
     (guild?.channels.cache.get(channelId)
    );
  const discordCount =
    discordChannel?.members?.filter((m) => !m.user.bot).size ?? 0;
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
  const discordChannel =
     (guild?.channels.cache.get(channelId)
    );
  return discordChannel?.members?.filter((m) => !m.user.bot).size ?? 0;
}
function getFluxerHumanCount(guildId, channelId) {
  return (
    fluxerChannelOccupancy.get(getFluxerOccupancyKey(guildId, channelId)) ?? 0
  );
}
function adjustFluxerOccupancy(guildId, channelId, delta) {
  const key = getFluxerOccupancyKey(guildId, channelId);
  const next = (fluxerChannelOccupancy.get(key) ?? 0) + delta;
  if (next > 0) {
    fluxerChannelOccupancy.set(key, next);
  } else {
    fluxerChannelOccupancy.delete(key);
  }
}
function updateFluxerVoiceState(guildId, userId, channelId) {
  const userKey = getFluxerUserStateKey(guildId, userId);
  const previousChannelId = fluxerVoiceStates.get(userKey);
  if (previousChannelId) {
    adjustFluxerOccupancy(guildId, previousChannelId, -1);
    fluxerVoiceStates.delete(userKey);
  }
  if (channelId) {
    fluxerVoiceStates.set(userKey, channelId);
    adjustFluxerOccupancy(guildId, channelId, 1);
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
    log(
      "VOICE",
      `Rejoin already scheduled for channel ${channelId}; keeping existing backoff`,
    );
    return;
  }
  const attempt = (existing?.attempt ?? 0) + 1;
  if (!shouldScheduleRejoinAttempt(attempt)) {
    clearRestartBackoff(channelId);
    log(
      "VOICE",
      `Not rejoining channel ${channelId}; reached max attempts (${MAX_REJOIN_ATTEMPTS}) after ${options.reason}`,
    );
    return;
  }
  const delay =
    RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)];
  log(
    "VOICE",
    `Scheduling rejoin for channel ${channelId} in ${delay}ms (${options.reason}, attempt ${attempt})`,
  );
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
function clearPendingForFluxerGuild(fluxerGuildId, keepChannelId) {
  for (const [channelId, creds] of pending) {
    if (creds.fluxerGuildId !== fluxerGuildId || channelId === keepChannelId)
      continue;
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
function isFluxerGuildInUse(fluxerGuildId, exceptChannelId) {
  for (const [id, session] of sessions) {
    if (id !== exceptChannelId && session.fluxerGuildId === fluxerGuildId) return true;
  }
  for (const [id, creds] of pending) {
    if (id !== exceptChannelId && creds.fluxerGuildId === fluxerGuildId) return true;
  }
  return false;
}
function sendLeaveOps(voiceClient, guildId, fluxerGuildId, leaveDiscord = true, exceptChannelId) {
  const guild =
    voiceClient?.guilds.cache.get(guildId) ??
    _discordClient?.guilds.cache.get(guildId);
  log("VOICE", `Leaving voice for discord=${guildId} fluxer=${fluxerGuildId}`);
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
  if (isFluxerGuildInUse(fluxerGuildId, exceptChannelId)) {
    log("VOICE", `Keeping Fluxer voice for guild=${fluxerGuildId}; another bridge still uses it`);
    return;
  }
  _fluxerClient?.sendToGateway(0, {
    op: 4,
    d: {
      guild_id: fluxerGuildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    },
  });
}
function requestSessionRestart(channelId, reason) {
  const session = sessions.get(channelId);
  if (!session || session.stopping || session.restartRequested) return;
  session.restartRequested = true;
  log("VOICE", `Restarting session for channel ${channelId}: ${reason}`);
  killBridge(channelId);
}
async function flushPendingRunnerRestarts() {
  if (!_discordClient || !hasRunner() || pendingRunnerRestarts.size === 0)
    return;
  for (const [channelId, { guildId }] of [...pendingRunnerRestarts]) {
    await rejoinMappedChannel(guildId, channelId, { requireFreshDiscord: true });
    pendingRunnerRestarts.delete(channelId);
  }
}
async function recoverActiveVoiceBridges(reason) {
  if (!_discordClient || !_fluxerClient || !_recoveryArmed || !hasRunner())
    return;
  const voiceMaps =  (await VoiceChannelMap.findAll()
  );
  for (const voiceMap of voiceMaps) {
    const channelId = voiceMap.discordChannelId;
    if (
      sessions.has(channelId) ||
      pending.has(channelId) ||
      pendingRunnerRestarts.has(channelId)
    )
      continue;
    const discordCount = getDiscordHumanCount(
      voiceMap.discordGuildId,
      voiceMap.discordChannelId,
    );
    const fluxerCount = getFluxerHumanCount(
      voiceMap.fluxerGuildId,
      voiceMap.fluxerChannelId,
    );
    if (discordCount === 0 && fluxerCount === 0) continue;
    log(
      "VOICE",
      `Recovering mapped VC ${channelId} after ${reason} (discord=${discordCount}, fluxer=${fluxerCount})`,
    );
    await rejoinMappedChannel(voiceMap.discordGuildId, channelId, {
      allowWithoutDiscord: fluxerCount > 0,
    });
  }
}
function scheduleStartupRecovery(reason) {
  if (_startupRecoveryScheduled) return;
  _startupRecoveryScheduled = true;
  queueMicrotask(async () => {
    _startupRecoveryScheduled = false;
    await flushPendingRunnerRestarts();
    await recoverActiveVoiceBridges(reason);
  });
}
async function rejoinMappedChannel(guildId, channelId, options = {}) {
  if (!_discordClient) return;
  if (sessions.has(channelId) || pending.has(channelId)) {
    log(
      "VOICE",
      `Skipping rejoin for channel ${channelId}; recovery is already in progress`,
    );
    return;
  }
  if (
    !options.allowWithoutDiscord &&
    getDiscordHumanCount(guildId, channelId) === 0
  ) {
    log(
      "VOICE",
      `Skipping rejoin for channel ${channelId}; no Discord users remain`,
    );
    return;
  }
  log("VOICE", `Rejoining Discord VC ${channelId}`);
  await sendJoinOp(guildId, channelId, {
    requireFreshDiscord: options.requireFreshDiscord,
  });
}
export async function setupVoiceHandling(discordClient, fluxerClient, extraVoiceClients = []) {
  _discordClient = discordClient;
  _voicePool = (extraVoiceClients ?? []).filter(Boolean);
  _fluxerClient = fluxerClient;
  onRunnerAvailable(() => {
    scheduleStartupRecovery("runner availability");
  });
  fluxerClient.on(FluxerEvents.Ready, () => {
    scheduleStartupRecovery("Fluxer ready");
  });
  const mapCount = await VoiceChannelMap.count();
  log("VOICE", `Loaded ${mapCount} voice map(s) across ${allVoiceClients().length} discord client(s)`);
  function attachDiscordVoiceGateway(voiceClient) {
  voiceClient.ws.on(GatewayDispatchEvents.VoiceStateUpdate, async (data) => {
    const ownerId = voiceClient.user?.id;
    if (!ownerId || data.user_id !== ownerId) return;
    const {
      guild_id: guildId,
      channel_id: channelId,
      session_id: sessionId,
    } = data;
    const stateKey = getDiscordStateKey(ownerId, guildId);
    log(
      "VOICE",
      `Discord gateway VoiceStateUpdate bot=${ownerId} guild=${guildId} channel=${channelId ?? "null"} session=${sessionId ?? "null"}`,
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
        log(
          "VOICE",
          `Ignoring Discord disconnect for guild ${guildId}; rejoin already pending`,
        );
        return;
      }
      latestDiscordVoiceState.delete(stateKey);
      log(
        "VOICE",
        `Clearing pending credentials for guild ${guildId} after disconnect`,
      );
      clearPendingForDiscordGuild(guildId, undefined, voiceClient);
      const activeChannelIds = findSessionChannelsByGuild(guildId).filter(
        (id) => sessions.get(id)?.voiceClient === voiceClient,
      );
      for (const activeChannelId of activeChannelIds) {
        requestSessionRestart(
          activeChannelId,
          "Discord bot voice state disconnected",
        );
      }
    }
  });
  voiceClient.ws.on(GatewayDispatchEvents.VoiceServerUpdate, async (data) => {
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
    log(
      "VOICE",
      `Discord gateway VoiceServerUpdate bot=${ownerId} guild=${guildId} endpoint=${endpoint ?? "null"}`,
    );
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
  fluxerClient.on(FluxerEvents.VoiceServerUpdate, async (data) => {
    const {
      guild_id: fluxerGuildId,
      channel_id: fluxerChannelId,
      endpoint: livekitUrl,
      token: livekitToken,
    } =  (data);
    if (!fluxerGuildId || !livekitUrl || !livekitToken) return;
    const serverKey = fluxerChannelId ? `${fluxerGuildId}:${fluxerChannelId}` : fluxerGuildId;
    latestFluxerVoiceServer.set(serverKey, { livekitUrl, livekitToken });
    for (const [channelId, creds] of pending) {
      if (creds.fluxerGuildId !== fluxerGuildId) continue;
      if (fluxerChannelId && creds.fluxerChannelId !== fluxerChannelId) continue;
      creds.livekitUrl = livekitUrl;
      creds.livekitToken = livekitToken;
      pending.set(channelId, creds);
      log("VOICE", `Got Fluxer voice server for ${channelId}`);
      await maybeLaunch(channelId);
    }
  });
  fluxerClient.on(FluxerEvents.VoiceStatesSync, (data) => {
    for (const state of data.voiceStates) {
      if (state.user_id === fluxerClient.user?.id) continue;
      updateFluxerVoiceState(data.guildId, state.user_id, state.channel_id);
    }
    if (_recoveryArmed) {
      scheduleStartupRecovery(`Fluxer voice sync for guild ${data.guildId}`);
    }
  });
  discordClient.on(
    DiscordEvents.VoiceStateUpdate,
    async (oldState, newState) => {
      if (newState.member?.user?.bot) return;
      const guildId = newState.guild?.id ?? oldState.guild?.id;
      if (!guildId) return;
      const joinedId = newState.channelId;
      const leftId = oldState.channelId;
      if (joinedId || leftId) {
        log(
          "VOICE",
          `User voice state guild=${guildId} user=${newState.member?.user?.id ?? oldState.member?.user?.id ?? "unknown"} joined=${joinedId ?? "null"} left=${leftId ?? "null"}`,
        );
      }
      if (
        joinedId &&
        (await findVoiceMap(guildId, joinedId)) &&
        !sessions.has(joinedId)
      ) {
        log(
          "VOICE",
          `Mapped Discord join detected for guild=${guildId} channel=${joinedId}`,
        );
        await sendJoinOp(guildId, joinedId);
      }
      if (leftId && leftId !== joinedId && sessions.has(leftId)) {
        checkAndMaybeStop(leftId);
      }
    },
  );
  fluxerClient.on("voiceStateUpdate", async (data) => {
    if (!data.guild_id) return;
    if (data.user_id !== fluxerClient.user?.id && !data.member?.user?.bot) {
      updateFluxerVoiceState(data.guild_id, data.user_id, data.channel_id);
    }
    if (!data.channel_id) return;
    if (data.user_id === fluxerClient.user?.id) return;
    if (data.member?.user?.bot) return;
    log(
      "VOICE",
      `Fluxer voiceStateUpdate guild=${data.guild_id} channel=${data.channel_id} user=${data.user_id}`,
    );
    const voiceMap = await findVoiceMapByFluxer(data.guild_id, data.channel_id);
    if (!voiceMap) {
      log(
        "VOICE",
        `Fluxer voiceStateUpdate had no configured map for guild=${data.guild_id} channel=${data.channel_id}`,
      );
      return;
    }
    if (sessions.has(voiceMap.discordChannelId)) return;
    log(
      "VOICE",
      `Mapped Fluxer join detected; requesting Discord join for channel ${voiceMap.discordChannelId}`,
    );
    await sendJoinOp(
      voiceMap.discordGuildId,
      voiceMap.discordChannelId,
    );
  });
}
export function startVoiceRecovery() {
  _recoveryArmed = true;
  scheduleStartupRecovery("startup complete");
}
async function sendJoinOp(
  guildId,
  channelId,
  options = {},
) {
  if (!guildId || !channelId) return;
  const voiceMap = await findVoiceMap(guildId, channelId);
  if (!voiceMap) {
    log(
      "VOICE",
      `sendJoinOp ignored; no map for guild=${guildId} channel=${channelId}`,
    );
    return;
  }
  if (!hasRunner()) {
    log("VOICE", `No runner available, not joining VC ${channelId}`);
    return;
  }
  if (sessions.has(channelId) || pending.has(channelId)) {
    log(
      "VOICE",
      `Join already in progress for channel ${channelId}; skipping duplicate request`,
    );
    return;
  }
  const voiceClient = pickVoiceClient(guildId, channelId);
  if (!voiceClient) {
    log(
      "VOICE",
      `No free Discord client for guild=${guildId} channel=${channelId}; add another token to DiscordVoiceTokens`,
    );
    return;
  }
  const botUserId = getClientUserId(voiceClient);
  const guild =
    voiceClient.guilds.cache.get(guildId) ??
    _discordClient?.guilds.cache.get(guildId) ??
    null;
  log("VOICE", `Joining Discord VC ${channelId} with bot=${botUserId}`);
  clearPendingForDiscordGuild(guildId, channelId, voiceClient);
  clearPendingForFluxerGuild(voiceMap.fluxerGuildId, channelId);
  const discordVoiceServerGeneration =
    bumpDiscordVoiceServerGeneration(voiceClient, guildId);
  const stateKey = getDiscordStateKey(botUserId, guildId);
  const discordState = latestDiscordVoiceState.get(stateKey);
  const discordServer = latestDiscordVoiceServer.get(stateKey);
  const fluxerServer =
    latestFluxerVoiceServer.get(`${voiceMap.fluxerGuildId}:${voiceMap.fluxerChannelId}`) ??
    latestFluxerVoiceServer.get(voiceMap.fluxerGuildId);
  const requireFreshDiscord = options.requireFreshDiscord ?? false;
  log(
    "VOICE",
    `Preparing join for ${channelId}${requireFreshDiscord ? " with fresh Discord state" : ""}`,
  );
  pending.set(channelId, {
    guildId,
    channelId,
    voiceClient,
    fluxerGuildId: voiceMap.fluxerGuildId,
    fluxerChannelId: voiceMap.fluxerChannelId,
    discordVoiceServerGeneration,
    sessionId: undefined,
    endpoint: requireFreshDiscord ? undefined : discordServer?.endpoint,
    token: requireFreshDiscord ? undefined : discordServer?.token,
    livekitUrl: fluxerServer?.livekitUrl,
    livekitToken: fluxerServer?.livekitToken,
  });
  clearPendingJoinWatchdog(channelId);
  if (requireFreshDiscord) {
    const watchdog = setTimeout(() => {
      pendingJoinWatchdogs.delete(channelId);
      const stillPending = pending.get(channelId);
      if (!stillPending) return;
      log(
        "VOICE",
        `Timed out waiting for fresh Discord voice state for ${channelId}`,
      );
      clearPendingChannel(channelId);
      sendLeaveOps(voiceClient, guildId, voiceMap.fluxerGuildId, true, channelId);
      scheduleSessionRejoin(channelId, guildId, {
        allowWithoutDiscord:
          getFluxerHumanCount(
            voiceMap.fluxerGuildId,
            voiceMap.fluxerChannelId,
          ) > 0,
        requireFreshDiscord: true,
        reason: "fresh Discord voice credentials timed out",
      });
    }, 15_000);
    pendingJoinWatchdogs.set(channelId, watchdog);
  }
  guild?.shard.send({
    op: 4,
    d: {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: false,
      self_deaf: false,
    },
  });
  _fluxerClient?.sendToGateway(0, {
    op: 4,
    d: {
      guild_id: voiceMap.fluxerGuildId,
      channel_id: voiceMap.fluxerChannelId,
      self_mute: false,
      self_deaf: false,
    },
  });
  await maybeLaunch(channelId);
}
async function maybeLaunch(channelId) {
  const creds = pending.get(channelId);
  if (!creds) return;
  const { guildId, voiceClient, sessionId, endpoint, token, livekitUrl, livekitToken } =
    creds;
  if (
    !sessionId ||
    !endpoint ||
    !token ||
    !channelId ||
    !livekitUrl ||
    !livekitToken
  ) {
    log("VOICE", `Waiting on voice state before spawning ${channelId}`);
    return;
  }
  const voiceMap = await findVoiceMap(guildId, channelId);
  if (!voiceMap) {
    log(
      "VOICE",
      `maybeLaunch aborted; no map for guild=${guildId} channel=${channelId}`,
    );
    return;
  }
  if (sessions.has(channelId)) return;
  clearPendingChannel(channelId);
  log("VOICE", `Spawning bridge for channel ${channelId}`);
  const spawned = spawnBridge(
    channelId,
    livekitUrl,
    {
      DISCORD_ENDPOINT: endpoint,
      DISCORD_TOKEN: token,
      DISCORD_SESSION_ID: sessionId,
      DISCORD_USER_ID: voiceClient.user?.id ?? "",
      DISCORD_GUILD_ID: guildId,
      DISCORD_CHANNEL_ID: channelId,
      LIVEKIT_URL: livekitUrl,
      LIVEKIT_TOKEN: livekitToken,
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
        const fluxerCount = getFluxerHumanCount(
          voiceMap.fluxerGuildId,
          voiceMap.fluxerChannelId,
        );
        const requireFreshDiscord = true;
        {
          const botId = getClientUserId(voiceClient);
          latestDiscordVoiceServer.delete(getDiscordStateKey(botId, guildId));
          latestDiscordVoiceState.delete(getDiscordStateKey(botId, guildId));
        }
        if (code === 6 || code === 7) {
          latestFluxerVoiceServer.delete(voiceMap.fluxerGuildId);
          latestFluxerVoiceServer.delete(`${voiceMap.fluxerGuildId}:${voiceMap.fluxerChannelId}`);
        }
        sessions.delete(channelId);
        if (restartRequested) {
          sendLeaveOps(voiceClient, guildId, voiceMap.fluxerGuildId, false, channelId);
          void rejoinMappedChannel(guildId, channelId, { requireFreshDiscord: true });
        } else if (typeof code === "number" && code !== 0) {
          sendLeaveOps(voiceClient, guildId, voiceMap.fluxerGuildId, requireFreshDiscord, channelId);
          scheduleSessionRejoin(channelId, guildId, {
            allowWithoutDiscord: fluxerCount > 0,
            requireFreshDiscord,
            reason: `bridge failure code ${code}`,
          });
        } else if (code === null) {
          sendLeaveOps(voiceClient, guildId, voiceMap.fluxerGuildId, false, channelId);
          pendingRunnerRestarts.set(channelId, { guildId });
          log(
            "VOICE",
            `Queued rejoin for channel ${channelId} until a runner reconnects`,
          );
        } else {
          sendLeaveOps(voiceClient, guildId, voiceMap.fluxerGuildId, true, channelId);
        }
      },
      onError(message) {
        log("VOICE", `Bridge error: ${message}`);
      },
    },
  );
  if (spawned) {
    sessions.set(channelId, {
      guildId,
      voiceClient,
      fluxerGuildId: voiceMap.fluxerGuildId,
      fluxerChannelId: voiceMap.fluxerChannelId,
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
