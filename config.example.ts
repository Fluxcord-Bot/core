const Config = {
  // The path for the bot's data directory. Probably do not touch if you're using Docker.
  DataFolderPath: "/data",

  // The Discord bot token
  DiscordBotToken: "DISCORD_BOT_TOKEN",

  // The Discord client ID
  DiscordClientId: "0000000000000000000",

  // The Fluxer bot token
  FluxerBotToken: "FLUXER_BOT_TOKEN",

  // The Fluxer temporary emoji store community ID
  FluxerTempEmojiGuildId: "0000000000000000000",

  // The admin account IDs. Allows accessing admin commands, and
  // also allows verifying bridging without having Manage Channel perms.
  AdminAccountIds: ["0000000000000000000"],

  // The categories that the bot will log, remove any that you don't need.
  // Categories are, FLUXER, DISCORD, DB, META, DEBUG
  LoggingCategories: ["FLUXER", "DISCORD", /*'DB',*/ "META"],

  // The prefix of the bot
  BotPrefix: "fc!",
};

export default Config;
