//@ts-check
import { Events as DiscordEvents, GatewayDispatchEvents } from "discord.js";
import { Events as FluxerEvents } from "@fluxerjs/core";
import { log } from "./Logger.js";
import { spawnBridge, killBridge, hasRunner } from "./VoiceRunnerServer.js";
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
 * @type {Map<string, { guildId: string, fluxerGuildId: string, fluxerEmpty: boolean }>}
 */
const sessions = new Map();

/**
 * Credentials gathered before spawning the bridge
 * Keyed by discord guild ID.
 * @type {Map<string, { channelId?: string, sessionId?: string, endpoint?: string, token?: string, livekitUrl?: string, livekitToken?: string }>}
 */
const pending = new Map();

/** @type {import("discord.js").Client | null} */
let _discordClient = null;
/** @type {import("@fluxerjs/core").Client | null} */
let _fluxerClient = null;

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
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function setupVoiceHandling(discordClient, fluxerClient) {
  _discordClient = discordClient;
  _fluxerClient = fluxerClient;

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
    if (!data.channel_id || !data.guild_id) return;
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
        sessions.delete(channelId);
        const guild = discordClient.guilds.cache.get(guildId);
        guild?.shard.send({
          op: 4,
          d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
        });
        _fluxerClient?.sendToGateway(0, {
          op: 4,
          d: { guild_id: voiceMap.fluxerGuildId, channel_id: null, self_mute: false, self_deaf: false },
        });
      },
      onError(message) {
        log("VOICE", `Bridge error: ${message}`);
      },
    }
  );

  if (spawned) {
    sessions.set(channelId, { guildId, fluxerGuildId: voiceMap.fluxerGuildId, fluxerEmpty: false });
  }
}

/** @param {string} channelId */
function stopSession(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;
  sessions.delete(channelId);
  killBridge(channelId);
  log("VOICE", `Session stopped for channel ${channelId}`);
}
