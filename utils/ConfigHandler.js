import Config from "../config.js";

const DefaultConfig = {
  FluxerAPIBaseURL: "https://api.fluxer.app",
  DataFolderPath: "/data",
  DiscordBotToken: "DISCORD_BOT_TOKEN",
  DiscordClientId: "0000000000000000000",
  FluxerBotToken: "FLUXER_BOT_TOKEN",
  FluxerTempEmojiGuildId: "0000000000000000000",
  AdminAccountIds: ["0000000000000000000"],
  EmbedFooterContent: "",
  LoggingCategories: ["FLUXER", "DISCORD", /*'DB',*/ "META", "VOICE"],
  BotPrefix: "fc!",

  // Voice channel bridge mappings. Each entry links a Discord voice channel
  // to a Fluxer voice channel. A Node.js subprocess is spawned per session.
  // VoiceChannelMaps: [{ discordGuildId, discordChannelId, fluxerGuildId, fluxerChannelId }]
  VoiceChannelMaps: [],

  ...Config,
};

export default DefaultConfig;
