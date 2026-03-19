//@ts-check
import { Events as DiscordEvents, GatewayDispatchEvents } from "discord.js";
import { Events as FluxerEvents } from "@fluxerjs/core";
import { log } from "./Logger.js";
import Config from "./ConfigHandler.js";
import { spawnBridge, killBridge, hasRunner } from "./VoiceRunnerServer.js";

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

/** @param {string} guildId @param {string} channelId */
function findVoiceMap(guildId, channelId) {
  return (Config.VoiceChannelMaps ?? []).find(
    (m) => m.discordGuildId === guildId && m.discordChannelId === channelId
  );
}

/** @param {string} fluxerGuildId @param {string} fluxerChannelId */
function findVoiceMapByFluxer(fluxerGuildId, fluxerChannelId) {
  return (Config.VoiceChannelMaps ?? []).find(
    (m) => m.fluxerGuildId === fluxerGuildId && m.fluxerChannelId === fluxerChannelId
  );
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
export function setupVoiceHandling(discordClient, fluxerClient) {
  _discordClient = discordClient;
  _fluxerClient = fluxerClient;

  discordClient.ws.on(GatewayDispatchEvents.VoiceStateUpdate, (data) => {
    if (data.user_id !== discordClient.user?.id) return;
    const { guild_id: guildId, channel_id: channelId, session_id: sessionId } = data;
    if (channelId) {
      const creds = pending.get(guildId) ?? {};
      creds.sessionId = sessionId;
      creds.channelId = channelId;
      pending.set(guildId, creds);
      maybeLaunch(discordClient, guildId);
    } else {
      pending.delete(guildId);
    }
  });

  discordClient.ws.on(GatewayDispatchEvents.VoiceServerUpdate, (data) => {
    const { guild_id: guildId, endpoint, token } = data;
    const creds = pending.get(guildId) ?? {};
    creds.endpoint = endpoint;
    creds.token = token;
    pending.set(guildId, creds);
    maybeLaunch(discordClient, guildId);
  });

  fluxerClient.on(FluxerEvents.VoiceServerUpdate, (data) => {
    const { guild_id: fluxerGuildId, endpoint: livekitUrl, token: livekitToken } = data;
    if (!fluxerGuildId || !livekitUrl || !livekitToken) return;

    const voiceMap = (Config.VoiceChannelMaps ?? []).find((m) => m.fluxerGuildId === fluxerGuildId);
    if (!voiceMap) return;

    const creds = pending.get(voiceMap.discordGuildId) ?? {};
    creds.livekitUrl = livekitUrl;
    creds.livekitToken = livekitToken;
    pending.set(voiceMap.discordGuildId, creds);
    maybeLaunch(discordClient, voiceMap.discordGuildId);
  });

  discordClient.on(DiscordEvents.VoiceStateUpdate, (oldState, newState) => {
    if (newState.member?.user?.bot) return;

    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const joinedId = newState.channelId;
    const leftId = oldState.channelId;

    if (joinedId && findVoiceMap(guildId, joinedId) && !sessions.has(joinedId)) {
      sendJoinOp(discordClient, newState.guild, guildId, joinedId);
    }

    if (leftId && leftId !== joinedId && sessions.has(leftId)) {
      checkAndMaybeStop(leftId);
    }
  });

  fluxerClient.on("voiceStateUpdate", (data) => {
    if (!data.channel_id || !data.guild_id) return;
    if (data.user_id === fluxerClient.user?.id) return;
    if (data.member?.user?.bot) return;

    const voiceMap = findVoiceMapByFluxer(data.guild_id, data.channel_id);
    if (!voiceMap) return;
    if (sessions.has(voiceMap.discordChannelId)) return;

    const guild = discordClient.guilds.cache.get(voiceMap.discordGuildId) ?? null;
    sendJoinOp(discordClient, guild, voiceMap.discordGuildId, voiceMap.discordChannelId);
  });
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("discord.js").Guild | null} guild
 * @param {string} guildId
 * @param {string} channelId
 */
function sendJoinOp(discordClient, guild, guildId, channelId) {
  const voiceMap = findVoiceMap(guildId, channelId);
  if (!voiceMap) return;
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
function maybeLaunch(discordClient, guildId) {
  const creds = pending.get(guildId);
  if (!creds) return;
  const { sessionId, endpoint, token, channelId, livekitUrl, livekitToken } = creds;
  if (!sessionId || !endpoint || !token || !channelId || !livekitUrl || !livekitToken) return;

  const voiceMap = findVoiceMap(guildId, channelId);
  if (!voiceMap) return;
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
