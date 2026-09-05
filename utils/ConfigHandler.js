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
  DatabaseEncryptionToken: "",
  /** @type {{ text: string, emoji: string | { fluxer: { name: string, id: string }, discord: string } | undefined }[]} */
  Motds: [],

  VoiceBridgingEnabled: false,

  RunnerWsPort: 8765,
  RunnerSecret: "",

  HealthcheckEnabled: true,
  HealthcheckPort: 8080,
  HealthcheckHost: "0.0.0.0",

  ...Config,
};

export default DefaultConfig;
