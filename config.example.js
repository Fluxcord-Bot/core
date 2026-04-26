const Config = {
  // The base URL of Fluxer API. If you're not using a self-hosted Fluxer instance,
  // do not touch this.
  FluxerAPIBaseURL: "https://api.fluxer.app",

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

  // The start line of the per-server bios of the bot.
  // Changes every bot start
  FluxerBioStart: "",
  DiscordBioStart: "",

  // The footer of every embed sent by Fluxcord. Optional.
  EmbedFooterContent: "",

  // The categories that the bot will log, remove any that you don't need.
  // Categories: FLUXER, DISCORD, DB, META, VOICE, DEBUG
  LoggingCategories: ["FLUXER", "DISCORD", /*'DB',*/ "META", "VOICE"],

  // The prefix of the bot
  BotPrefix: "fc!",

  // The port the voice runner WebSocket server listens on.
  RunnerWsPort: 8765,

  // Secret shared between the core bot and voice runners. Set to a long random string.
  RunnerSecret: "",

  // Enable voice channel bridging. Manage mappings with voicebridge/voiceunbridge commands.
  // Requires the voice repository.
  // VoiceBridgingEnabled: false,
};

export default Config;
