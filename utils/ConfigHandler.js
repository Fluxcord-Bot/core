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
  LoggingCategories: ["FLUXER", "DISCORD", /*'DB',*/ "META"],
  BotPrefix: "fc!",

  ...Config,
};

export default DefaultConfig;
