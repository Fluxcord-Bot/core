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

  // Voice channel bridge mappings (optional).
  // Each entry links a Discord voice channel to a Fluxer voice channel.
  // Leave empty (or omit) to disable voice bridging entirely.
  //
  // Requires voice/node_modules to be installed: cd voice && pnpm install (or npm install)
  //
  // VoiceChannelMaps: [
  //   {
  //     discordGuildId: "123456789012345678",   // Discord server ID
  //     discordChannelId: "234567890123456789", // Discord voice channel ID
  //     fluxerGuildId: "345678901234567890",    // Fluxer community ID
  //     fluxerChannelId: "456789012345678901",  // Fluxer voice channel ID
  //   },
  // ],
};

export default Config;
