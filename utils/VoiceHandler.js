//@ts-check
import { Events as DiscordEvents, GatewayDispatchEvents } from "discord.js";
import { Events as FluxerEvents } from "@fluxerjs/core";
import { log } from "./Logger.js";
import { spawnBridge, killBridge, hasRunner, onRunnerAvailable } from "./VoiceRunnerServer.js";
import { VoiceChannelMap } from "../db/index.js";

/**
 * Sequelize model instance shape for a voice bridge row.
 * This is type-only — pls do not mirror these as runtime class fields.
 * @typedef {import("sequelize").Model & {
 *   discordGuildId: string,
 *   discordChannelId: string,
 *   fluxerGuildId: string,
 *   fluxerChannelId: string,
 * }} VoiceChannelMapRecord
 */

/**
 * Active voice sessions keyed by discord channel ID.
 * @type {Map<string, {
 *   guildId: string,
 *   fluxerGuildId: string,
 *   fluxerChannelId: string,
 *   fluxerEmpty: boolean,
 *   stopping: boolean,
 *   restartRequested: boolean,
 * }>}
 */
const sessions = new Map();

/**
 * Credentials gathered before spawning the bridge.
 * Keyed by Discord voice channel ID so separate channels in the same guild
 * cannot overwrite each other's pending launch state.
 * @type {Map<string, {
 *   guildId: string,
 *   channelId: string,
 *   fluxerGuildId: string,
 *   fluxerChannelId: string,
 *   discordVoiceServerGeneration: number,
 *   sessionId?: string,
 *   endpoint?: string,
 *   token?: string,
 *   livekitUrl?: string,
 *   livekitToken?: string,
 * }>}
 */
const pending = new Map();

/**
 * Latest Discord gateway voice state for the bot, keyed by guild ID.
 * @type {Map<string, { channelId?: string, sessionId?: string }>}
 */
const latestDiscordVoiceState = new Map();

/**
 * Latest Discord gateway voice server payload for the bot, keyed by guild ID.
 * @type {Map<string, { endpoint?: string, token?: string, generation?: number }>}
 */
const latestDiscordVoiceServer = new Map();

/**
 * Latest Fluxer voice server payload for the bot, keyed by Fluxer guild ID.
 * @type {Map<string, { livekitUrl?: string, livekitToken?: string }>}
 */
const latestFluxerVoiceServer = new Map();

/**
 * Session restarts waiting for a runner to become available again.
 * Keyed by discord channel ID.
 * @type {Map<string, { guildId: string }>}
 */
const pendingRunnerRestarts = new Map();
/** @type {Map<string, { attempt: number, timer: NodeJS.Timeout | null }>} */
const restartBackoff = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const pendingJoinWatchdogs = new Map();

/**
 * Latest known Fluxer voice channel per user.
 * Keyed by `${guildId}:${userId}`.
 * @type {Map<string, string>}
 */
const fluxerVoiceStates = new Map();

/**
 * Latest known human occupancy per Fluxer voice channel.
 * Keyed by `${guildId}:${channelId}`.
 * @type {Map<string, number>}
 */
const fluxerChannelOccupancy = new Map();

/** @type {import("discord.js").Client | null} */
let _discordClient = null;
/** @type {import("@fluxerjs/core").Client | null} */
let _fluxerClient = null;
let _startupRecoveryScheduled = false;
let _recoveryArmed = false;
const RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * @param {string} guildId
 * @param {string} channelId
 * @returns {string}
 */
function getFluxerOccupancyKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {string}
 */
function getFluxerUserStateKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @returns {Promise<VoiceChannelMapRecord | null>}
 */
async function findVoiceMap(guildId, channelId) {
  if (!guildId || !channelId) return null;
  return /** @type {Promise<VoiceChannelMapRecord | null>} */ (VoiceChannelMap.findOne({
    where: { discordGuildId: guildId, discordChannelId: channelId },
  }));
}

/**
 * @param {string} fluxerGuildId
 * @param {string} fluxerChannelId
 * @returns {Promise<VoiceChannelMapRecord | null>}
 */
async function findVoiceMapByFluxer(fluxerGuildId, fluxerChannelId) {
  if (!fluxerGuildId || !fluxerChannelId) return null;
  return /** @type {Promise<VoiceChannelMapRecord | null>} */ (VoiceChannelMap.findOne({
    where: { fluxerGuildId, fluxerChannelId },
  }));
}

/**
 * Stop the session only if both discord and fluxer VCs are empty
 * @param {string} channelId Discord channel ID
 */
function checkAndMaybeStop(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;

  const guild = _discordClient?.guilds.cache.get(session.guildId);
  const discordChannel = /** @type {import("discord.js").VoiceChannel | undefined} */ (guild?.channels.cache.get(channelId));
  const discordCount = discordChannel?.members?.filter((m) => !m.user.bot).size ?? 0;

  if (discordCount === 0 && session.fluxerEmpty) {
    stopSession(channelId);
  }
}

/**
 * @param {string} guildId
 * @returns {string | null}
 */
function findSessionChannelByGuild(guildId) {
  for (const [channelId, session] of sessions) {
    if (session.guildId === guildId) return channelId;
  }
  return null;
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @returns {number}
 */
function getDiscordHumanCount(guildId, channelId) {
  const guild = _discordClient?.guilds.cache.get(guildId);
  const discordChannel = /** @type {import("discord.js").VoiceChannel | undefined} */ (guild?.channels.cache.get(channelId));
  return discordChannel?.members?.filter((m) => !m.user.bot).size ?? 0;
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @returns {number}
 */
function getFluxerHumanCount(guildId, channelId) {
  return fluxerChannelOccupancy.get(getFluxerOccupancyKey(guildId, channelId)) ?? 0;
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @param {number} delta
 */
function adjustFluxerOccupancy(guildId, channelId, delta) {
  const key = getFluxerOccupancyKey(guildId, channelId);
  const next = (fluxerChannelOccupancy.get(key) ?? 0) + delta;
  if (next > 0) {
    fluxerChannelOccupancy.set(key, next);
  } else {
    fluxerChannelOccupancy.delete(key);
  }
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {string | null | undefined} channelId
 */
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

/** @param {string} channelId */
function clearRestartBackoff(channelId) {
  const state = restartBackoff.get(channelId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
  }
  restartBackoff.delete(channelId);
}

/** @param {string} channelId */
function clearPendingJoinWatchdog(channelId) {
  const timer = pendingJoinWatchdogs.get(channelId);
  if (!timer) return;
  clearTimeout(timer);
  pendingJoinWatchdogs.delete(channelId);
}

/**
 * @param {string} channelId
 * @param {string} guildId
 * @param {{
 *   allowWithoutDiscord: boolean,
 *   requireFreshDiscord?: boolean,
 *   reason: string,
 * }} options
 */
function scheduleSessionRejoin(channelId, guildId, options) {
  const existing = restartBackoff.get(channelId);
  if (existing?.timer) {
    log("VOICE", `Rejoin already scheduled for channel ${channelId}; keeping existing backoff`);
    return;
  }
  const attempt = (existing?.attempt ?? 0) + 1;
  const delay = RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)];
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

/**
 * @param {string} channelId
 */
function clearPendingChannel(channelId) {
  clearPendingJoinWatchdog(channelId);
  pending.delete(channelId);
}

/**
 * @param {string} guildId
 * @param {string} [keepChannelId]
 */
function clearPendingForDiscordGuild(guildId, keepChannelId) {
  for (const [channelId, creds] of pending) {
    if (creds.guildId !== guildId || channelId === keepChannelId) continue;
    clearPendingJoinWatchdog(channelId);
    pending.delete(channelId);
  }
}

/**
 * @param {string} fluxerGuildId
 * @param {string} [keepChannelId]
 */
function clearPendingForFluxerGuild(fluxerGuildId, keepChannelId) {
  for (const [channelId, creds] of pending) {
    if (creds.fluxerGuildId !== fluxerGuildId || channelId === keepChannelId) continue;
    clearPendingJoinWatchdog(channelId);
    pending.delete(channelId);
  }
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @returns {{
 *   guildId: string,
 *   channelId: string,
 *   fluxerGuildId: string,
 *   fluxerChannelId: string,
 *   discordVoiceServerGeneration: number,
 *   sessionId?: string,
 *   endpoint?: string,
 *   token?: string,
 *   livekitUrl?: string,
 *   livekitToken?: string,
 * } | null}
 */
function getPendingChannelForGuild(guildId, channelId) {
  const creds = pending.get(channelId);
  if (!creds || creds.guildId !== guildId) return null;
  return creds;
}

/** @param {string} guildId */
function hasPendingChannelForGuild(guildId) {
  for (const creds of pending.values()) {
    if (creds.guildId === guildId) return true;
  }
  return false;
}

/**
 * Make the next join wait for a fresh Discord VoiceServerUpdate.
 * @param {string} guildId
 * @returns {number}
 */
function bumpDiscordVoiceServerGeneration(guildId) {
  const current = latestDiscordVoiceServer.get(guildId);
  const generation = (current?.generation ?? 0) + 1;
  latestDiscordVoiceServer.set(guildId, {
    endpoint: current?.endpoint,
    token: current?.token,
    generation,
  });
  return generation;
}

/**
 * @param {string} guildId
 * @param {string} fluxerGuildId
 * @param {boolean} leaveDiscord
 */
function sendLeaveOps(guildId, fluxerGuildId, leaveDiscord = true) {
  const guild = _discordClient?.guilds.cache.get(guildId);
  log("VOICE", `Leaving voice for discord=${guildId} fluxer=${fluxerGuildId}`);
  if (leaveDiscord) {
    guild?.shard.send({
      op: 4,
      d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
    });
  }
  _fluxerClient?.sendToGateway(0, {
    op: 4,
    d: { guild_id: fluxerGuildId, channel_id: null, self_mute: false, self_deaf: false },
  });
}

/**
 * @param {string} channelId
 * @param {string} reason
 */
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
    await rejoinMappedChannel(guildId, channelId);
    pendingRunnerRestarts.delete(channelId);
  }
}

/**
 * @param {string} reason
 */
async function recoverActiveVoiceBridges(reason) {
  if (!_discordClient || !_fluxerClient || !_recoveryArmed || !hasRunner()) return;

  const voiceMaps = /** @type {VoiceChannelMapRecord[]} */ (await VoiceChannelMap.findAll());
  for (const voiceMap of voiceMaps) {
    const channelId = voiceMap.discordChannelId;
    if (sessions.has(channelId) || pending.has(channelId) || pendingRunnerRestarts.has(channelId)) continue;

    const discordCount = getDiscordHumanCount(voiceMap.discordGuildId, voiceMap.discordChannelId);
    const fluxerCount = getFluxerHumanCount(voiceMap.fluxerGuildId, voiceMap.fluxerChannelId);
    if (discordCount === 0 && fluxerCount === 0) continue;

    log(
      "VOICE",
      `Recovering mapped VC ${channelId} after ${reason} (discord=${discordCount}, fluxer=${fluxerCount})`,
    );
    await rejoinMappedChannel(voiceMap.discordGuildId, channelId, { allowWithoutDiscord: fluxerCount > 0 });
  }
}

/**
 * @param {string} reason
 */
function scheduleStartupRecovery(reason) {
  if (_startupRecoveryScheduled) return;
  _startupRecoveryScheduled = true;
  queueMicrotask(async () => {
    _startupRecoveryScheduled = false;
    await flushPendingRunnerRestarts();
    await recoverActiveVoiceBridges(reason);
  });
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @param {{ allowWithoutDiscord?: boolean, requireFreshDiscord?: boolean }} [options]
 */
async function rejoinMappedChannel(guildId, channelId, options = {}) {
  if (!_discordClient) return;
  const guild = _discordClient?.guilds.cache.get(guildId) ?? null;
  if (sessions.has(channelId) || pending.has(channelId)) {
    log("VOICE", `Skipping rejoin for channel ${channelId}; recovery is already in progress`);
    return;
  }
  if (!options.allowWithoutDiscord && getDiscordHumanCount(guildId, channelId) === 0) {
    log("VOICE", `Skipping rejoin for channel ${channelId}; no Discord users remain`);
    return;
  }
  log("VOICE", `Rejoining Discord VC ${channelId}`);
  await sendJoinOp(_discordClient, guild, guildId, channelId, { requireFreshDiscord: options.requireFreshDiscord });
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function setupVoiceHandling(discordClient, fluxerClient) {
  _discordClient = discordClient;
  _fluxerClient = fluxerClient;
  onRunnerAvailable(() => {
    scheduleStartupRecovery("runner availability");
  });
  fluxerClient.on(FluxerEvents.Ready, () => {
    scheduleStartupRecovery("Fluxer ready");
  });

  const mapCount = await VoiceChannelMap.count();
  log("VOICE", `Loaded ${mapCount} voice map(s)`);

  discordClient.ws.on(GatewayDispatchEvents.VoiceStateUpdate, async (data) => {
    if (data.user_id !== discordClient.user?.id) return;
    const { guild_id: guildId, channel_id: channelId, session_id: sessionId } = data;
    log("VOICE", `Discord gateway VoiceStateUpdate guild=${guildId} channel=${channelId ?? "null"} session=${sessionId ?? "null"}`);
    if (channelId) {
      latestDiscordVoiceState.set(guildId, { channelId, sessionId });
      const creds = getPendingChannelForGuild(guildId, channelId);
      if (creds) {
        creds.sessionId = sessionId;
        pending.set(channelId, creds);
        log("VOICE", `Got Discord session for ${channelId}`);
        await maybeLaunch(discordClient, channelId);
      }
    } else {
      if (hasPendingChannelForGuild(guildId)) {
        log("VOICE", `Ignoring Discord disconnect for guild ${guildId}; rejoin already pending`);
        return;
      }
      latestDiscordVoiceState.delete(guildId);
      log("VOICE", `Clearing pending credentials for guild ${guildId} after disconnect`);
      clearPendingForDiscordGuild(guildId);
      const activeChannelId = findSessionChannelByGuild(guildId);
      if (activeChannelId) {
        requestSessionRestart(activeChannelId, "Discord bot voice state disconnected");
      }
    }
  });

  discordClient.ws.on(GatewayDispatchEvents.VoiceServerUpdate, async (data) => {
    const { guild_id: guildId, endpoint, token } = data;
    log("VOICE", `Discord gateway VoiceServerUpdate guild=${guildId} endpoint=${endpoint ?? "null"}`);
    const current = latestDiscordVoiceServer.get(guildId);
    const generation = current?.generation ?? 0;
    latestDiscordVoiceServer.set(guildId, { endpoint, token, generation });
    for (const [channelId, creds] of pending) {
      if (creds.guildId !== guildId) continue;
      if (creds.discordVoiceServerGeneration !== generation) continue;
      creds.endpoint = endpoint;
      creds.token = token;
      pending.set(channelId, creds);
      log("VOICE", `Got Discord voice server for ${channelId}`);
      await maybeLaunch(discordClient, channelId);
    }
  });

  fluxerClient.on(FluxerEvents.VoiceServerUpdate, async (data) => {
    const { guild_id: fluxerGuildId, endpoint: livekitUrl, token: livekitToken } = data;
    if (!fluxerGuildId || !livekitUrl || !livekitToken) return;

    latestFluxerVoiceServer.set(fluxerGuildId, { livekitUrl, livekitToken });
    for (const [channelId, creds] of pending) {
      if (creds.fluxerGuildId !== fluxerGuildId) continue;
      creds.livekitUrl = livekitUrl;
      creds.livekitToken = livekitToken;
      pending.set(channelId, creds);
      log("VOICE", `Got Fluxer voice server for ${channelId}`);
      await maybeLaunch(discordClient, channelId);
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

  discordClient.on(DiscordEvents.VoiceStateUpdate, async (oldState, newState) => {
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

    if (joinedId && (await findVoiceMap(guildId, joinedId)) && !sessions.has(joinedId)) {
      log("VOICE", `Mapped Discord join detected for guild=${guildId} channel=${joinedId}`);
      await sendJoinOp(discordClient, newState.guild, guildId, joinedId);
    }

    if (leftId && leftId !== joinedId && sessions.has(leftId)) {
      checkAndMaybeStop(leftId);
    }
  });

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
      log("VOICE", `Fluxer voiceStateUpdate had no configured map for guild=${data.guild_id} channel=${data.channel_id}`);
      return;
    }
    if (sessions.has(voiceMap.discordChannelId)) return;

    const guild = discordClient.guilds.cache.get(voiceMap.discordGuildId) ?? null;
    log("VOICE", `Mapped Fluxer join detected; requesting Discord join for channel ${voiceMap.discordChannelId}`);
    await sendJoinOp(discordClient, guild, voiceMap.discordGuildId, voiceMap.discordChannelId);
  });
}

export function startVoiceRecovery() {
  _recoveryArmed = true;
  scheduleStartupRecovery("startup complete");
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("discord.js").Guild | null} guild
 * @param {string} guildId
 * @param {string} channelId
 * @param {{ requireFreshDiscord?: boolean }} [options]
 */
async function sendJoinOp(discordClient, guild, guildId, channelId, options = {}) {
  if (!guildId || !channelId) return;
  const voiceMap = await findVoiceMap(guildId, channelId);
  if (!voiceMap) {
    log("VOICE", `sendJoinOp ignored; no map for guild=${guildId} channel=${channelId}`);
    return;
  }
  if (!hasRunner()) {
    log("VOICE", `No runner available, not joining VC ${channelId}`);
    return;
  }
  if (sessions.has(channelId) || pending.has(channelId)) {
    log("VOICE", `Join already in progress for channel ${channelId}; skipping duplicate request`);
    return;
  }

  log("VOICE", `Joining Discord VC ${channelId}`);
  clearPendingForDiscordGuild(guildId, channelId);
  clearPendingForFluxerGuild(voiceMap.fluxerGuildId, channelId);
  const discordVoiceServerGeneration = bumpDiscordVoiceServerGeneration(guildId);
  const discordState = latestDiscordVoiceState.get(guildId);
  const discordServer = latestDiscordVoiceServer.get(guildId);
  const fluxerServer = latestFluxerVoiceServer.get(voiceMap.fluxerGuildId);
  const requireFreshDiscord = options.requireFreshDiscord ?? false;
  log("VOICE", `Preparing join for ${channelId}${requireFreshDiscord ? " with fresh Discord state" : ""}`);
  pending.set(channelId, {
    guildId,
    channelId,
    fluxerGuildId: voiceMap.fluxerGuildId,
    fluxerChannelId: voiceMap.fluxerChannelId,
    discordVoiceServerGeneration,
    sessionId: requireFreshDiscord
      ? undefined
      : (discordState?.channelId === channelId ? discordState.sessionId : undefined),
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
      log("VOICE", `Timed out waiting for fresh Discord voice state for ${channelId}`);
      clearPendingChannel(channelId);
      sendLeaveOps(guildId, voiceMap.fluxerGuildId, true);
      scheduleSessionRejoin(channelId, guildId, {
        allowWithoutDiscord: getFluxerHumanCount(voiceMap.fluxerGuildId, voiceMap.fluxerChannelId) > 0,
        requireFreshDiscord: true,
        reason: "fresh Discord voice credentials timed out",
      });
    }, 15_000);
    pendingJoinWatchdogs.set(channelId, watchdog);
  }

  guild?.shard.send({
    op: 4,
    d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false },
  });

  _fluxerClient?.sendToGateway(0, {
    op: 4,
    d: { guild_id: voiceMap.fluxerGuildId, channel_id: voiceMap.fluxerChannelId, self_mute: false, self_deaf: false },
  });

  await maybeLaunch(discordClient, channelId);
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {string} channelId
 */
async function maybeLaunch(discordClient, channelId) {
  const creds = pending.get(channelId);
  if (!creds) return;
  const { guildId, sessionId, endpoint, token, livekitUrl, livekitToken } = creds;
  if (!sessionId || !endpoint || !token || !channelId || !livekitUrl || !livekitToken) {
    log("VOICE", `Waiting on voice state before spawning ${channelId}`);
    return;
  }

  const voiceMap = await findVoiceMap(guildId, channelId);
  if (!voiceMap) {
    log("VOICE", `maybeLaunch aborted; no map for guild=${guildId} channel=${channelId}`);
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
      DISCORD_USER_ID: discordClient.user?.id ?? "",
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
        const fluxerCount = getFluxerHumanCount(voiceMap.fluxerGuildId, voiceMap.fluxerChannelId);
        const requireFreshDiscord = code === 2 || code === 4;
        sessions.delete(channelId);
        if (restartRequested) {
          sendLeaveOps(guildId, voiceMap.fluxerGuildId, false);
          void rejoinMappedChannel(guildId, channelId);
        } else if (typeof code === "number" && code !== 0) {
          sendLeaveOps(guildId, voiceMap.fluxerGuildId, requireFreshDiscord);
          scheduleSessionRejoin(channelId, guildId, {
            allowWithoutDiscord: fluxerCount > 0,
            requireFreshDiscord,
            reason: `bridge failure code ${code}`,
          });
        } else if (code === null) {
          sendLeaveOps(guildId, voiceMap.fluxerGuildId, false);
          pendingRunnerRestarts.set(channelId, { guildId });
          log("VOICE", `Queued rejoin for channel ${channelId} until a runner reconnects`);
        } else {
          sendLeaveOps(guildId, voiceMap.fluxerGuildId, true);
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
      fluxerGuildId: voiceMap.fluxerGuildId,
      fluxerChannelId: voiceMap.fluxerChannelId,
      fluxerEmpty: false,
      stopping: false,
      restartRequested: false,
    });
  }
}

/** @param {string} channelId */
function stopSession(channelId) {
  const session = sessions.get(channelId);
  if (!session || session.stopping) return;
  session.stopping = true;
  killBridge(channelId);
  log("VOICE", `Session stopped for channel ${channelId}`);
}
