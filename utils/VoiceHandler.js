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
 * Credentials gathered before spawning the bridge
 * Keyed by discord guild ID.
 * @type {Map<string, { channelId?: string, sessionId?: string, endpoint?: string, token?: string, livekitUrl?: string, livekitToken?: string }>}
 */
const pending = new Map();

/**
 * Session restarts waiting for a runner to become available again.
 * Keyed by discord channel ID.
 * @type {Map<string, { guildId: string }>}
 */
const pendingRunnerRestarts = new Map();

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

/**
 * @param {string} guildId
 * @param {string} fluxerGuildId
 * @param {boolean} leaveDiscord
 */
function sendLeaveOps(guildId, fluxerGuildId, leaveDiscord = true) {
  const guild = _discordClient?.guilds.cache.get(guildId);
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
    pendingRunnerRestarts.delete(channelId);
    await rejoinMappedChannel(guildId, channelId);
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
    if (sessions.has(channelId) || pendingRunnerRestarts.has(channelId)) continue;

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
 * @param {{ allowWithoutDiscord?: boolean }} [options]
 */
async function rejoinMappedChannel(guildId, channelId, options = {}) {
  if (!_discordClient) return;
  const guild = _discordClient?.guilds.cache.get(guildId) ?? null;
  if (!options.allowWithoutDiscord && getDiscordHumanCount(guildId, channelId) === 0) {
    log("VOICE", `Skipping rejoin for channel ${channelId}; no Discord users remain`);
    return;
  }
  log("VOICE", `Rejoining Discord VC ${channelId}`);
  await sendJoinOp(_discordClient, guild, guildId, channelId);
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

  const mapCount = await VoiceChannelMap.count();
  log("VOICE", `Loaded ${mapCount} voice map(s)`);

  discordClient.ws.on(GatewayDispatchEvents.VoiceStateUpdate, async (data) => {
    if (data.user_id !== discordClient.user?.id) return;
    const { guild_id: guildId, channel_id: channelId, session_id: sessionId } = data;
    log("VOICE", `Discord gateway VoiceStateUpdate guild=${guildId} channel=${channelId ?? "null"} session=${sessionId ?? "null"}`);
    if (channelId) {
      const creds = pending.get(guildId) ?? {};
      creds.sessionId = sessionId;
      creds.channelId = channelId;
      pending.set(guildId, creds);
      await maybeLaunch(discordClient, guildId);
    } else {
      log("VOICE", `Clearing pending credentials for guild ${guildId} after disconnect`);
      pending.delete(guildId);
      const activeChannelId = findSessionChannelByGuild(guildId);
      if (activeChannelId) {
        requestSessionRestart(activeChannelId, "Discord bot voice state disconnected");
      }
    }
  });

  discordClient.ws.on(GatewayDispatchEvents.VoiceServerUpdate, async (data) => {
    const { guild_id: guildId, endpoint, token } = data;
    log("VOICE", `Discord gateway VoiceServerUpdate guild=${guildId} endpoint=${endpoint ?? "null"}`);
    const creds = pending.get(guildId) ?? {};
    creds.endpoint = endpoint;
    creds.token = token;
    pending.set(guildId, creds);
    await maybeLaunch(discordClient, guildId);
  });

  fluxerClient.on(FluxerEvents.VoiceServerUpdate, async (data) => {
    const { guild_id: fluxerGuildId, endpoint: livekitUrl, token: livekitToken } = data;
    if (!fluxerGuildId || !livekitUrl || !livekitToken) return;

    const voiceMap = /** @type {VoiceChannelMapRecord | null} */ (await VoiceChannelMap.findOne({ where: { fluxerGuildId } }));
    if (!voiceMap) {
      log("VOICE", `Fluxer VoiceServerUpdate for guild ${fluxerGuildId} had no configured map`);
      return;
    }

    log("VOICE", `Fluxer VoiceServerUpdate matched map discordGuild=${voiceMap.discordGuildId}`);

    const creds = pending.get(voiceMap.discordGuildId) ?? {};
    creds.livekitUrl = livekitUrl;
    creds.livekitToken = livekitToken;
    pending.set(voiceMap.discordGuildId, creds);
    await maybeLaunch(discordClient, voiceMap.discordGuildId);
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
 */
async function sendJoinOp(discordClient, guild, guildId, channelId) {
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

  log("VOICE", `Joining Discord VC ${channelId}`);
  const creds = pending.get(guildId) ?? {};
  creds.channelId = channelId;
  pending.set(guildId, creds);

  guild?.shard.send({
    op: 4,
    d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false },
  });

  _fluxerClient?.sendToGateway(0, {
    op: 4,
    d: { guild_id: voiceMap.fluxerGuildId, channel_id: voiceMap.fluxerChannelId, self_mute: false, self_deaf: false },
  });
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {string} guildId
 */
async function maybeLaunch(discordClient, guildId) {
  const creds = pending.get(guildId);
  if (!creds) return;
  const { sessionId, endpoint, token, channelId, livekitUrl, livekitToken } = creds;
  if (!sessionId || !endpoint || !token || !channelId || !livekitUrl || !livekitToken) {
    log(
      "VOICE",
      `Waiting launch prerequisites for guild=${guildId}: session=${!!sessionId} endpoint=${!!endpoint} token=${!!token} channel=${!!channelId} livekitUrl=${!!livekitUrl} livekitToken=${!!livekitToken}`,
    );
    return;
  }

  const voiceMap = await findVoiceMap(guildId, channelId);
  if (!voiceMap) {
    log("VOICE", `maybeLaunch aborted; no map for guild=${guildId} channel=${channelId}`);
    return;
  }
  if (sessions.has(channelId)) return;

  pending.delete(guildId);
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
        if (msg === "fluxer-empty") {
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
        sessions.delete(channelId);
        sendLeaveOps(guildId, voiceMap.fluxerGuildId, !restartRequested);
        if (restartRequested) {
          void rejoinMappedChannel(guildId, channelId);
        } else if (code === null) {
          pendingRunnerRestarts.set(channelId, { guildId });
          log("VOICE", `Queued rejoin for channel ${channelId} until a runner reconnects`);
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
