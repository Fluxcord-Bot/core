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
  FluxerBioStart: "",
  DiscordBioStart: "",

  VoiceBridgingEnabled: false,

  RunnerWsPort: 8765,
  RunnerSecret: "",

  ...Config,
};

export default DefaultConfig;
