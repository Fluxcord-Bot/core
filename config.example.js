const Config = {
  // The base URL of the Fluxer API. Change this only if you're using a self-hosted instance.
  // FluxerAPIBaseURL: "https://example.com/api",
  FluxerAPIBaseURL: "https://api.fluxer.app",

  // The path for the bot's data directory. Probably do not touch if you're using Docker.
  DataFolderPath: "/data",

  // The database encryption token. If you're just running a instance for yourself
  // you don't really need to set this.
  // NOTE: Only applies to SQLite. Ignored when PostgresConnectionString is set.
  DatabaseEncryptionToken: "",

  // Optional. When set, PostgreSQL is used instead of SQLite.
  // When empty/unset, SQLite (DataFolderPath + "/fluxcord.db") is used.
  // The DatabaseEncryptionToken is ignored in Postgres mode, and
  // `pnpm run migrate:to-postgres` can copy your existing SQLite data
  // (decrypting it first if needed) into Postgres.
  // Example: "postgres://user:password@localhost:5432/fluxcord"
  // PostgresConnectionString: "",

  // The Discord bot token. Optional: if you only bridge between Fluxer instances
  // (or multiple self-hosted Fluxer instances), you can omit this entirely and
  // Fluxcord runs without a Discord bot.
  DiscordBotToken: "DISCORD_BOT_TOKEN",

  // Additional bot tokens for voice bridging multiple voice channels at the same time. Optional.
  DiscordVoiceTokens: [
    // "VOICE_TOKEN_1",
    // "VOICE_TOKEN_2",
  ],

  // The Discord client ID
  DiscordClientId: "0000000000000000000",

  // The Fluxer bot token
  FluxerBotToken: "FLUXER_BOT_TOKEN",

  // Multi-instance Fluxer support. Each entry runs its own bot client in this process.
  // The entry with id "default" (or the legacy single-token fields above) is used
  // wherever no explicit instance is specified. If FluxerInstances is set but has no
  // "default" entry, one is synthesized from FluxerBotToken + FluxerAPIBaseURL above.
  // FluxerInstances: [
  //   {
  //     id: "default",
  //     token: "FLUXER_BOT_TOKEN",
  //     FluxerAPIBaseURL: "https://api.fluxer.app",
  //   },
  //   {
  //     id: "selfhosted",
  //     token: "OTHER_FLUXER_BOT_TOKEN",
  //     FluxerAPIBaseURL: "https://my-fluxer.example.com/api",
  //   },
  // ],
  // Each entry can also override (per instance):
  //   FluxerTempEmojiGuildId - REQUIRED for every instance; each instance needs
  //     its own temporary emoji store community (bot startup fails without it).
  //   FluxerBioStart - the bio prefix used on that instance's bot (falls back to
  //     the root FluxerBioStart).
  //   EmbedFooterContent - the embed footer used for embeds sent to that
  //     instance (falls back to the root EmbedFooterContent).
  // and set `discovery` / `instance` for self-hosted Fluxer connections.

  // The Fluxer temporary emoji store community ID
  FluxerTempEmojiGuildId: "0000000000000000000",

  // The admin account IDs. Allows accessing admin commands, and
  // also allows verifying bridging without having Manage Channel perms.
  AdminAccountIds: ["0000000000000000000"],

  // The start line of the per-server bios of the bot.
  // Changes every bot start
  FluxerBioStart: "",
  DiscordBioStart: "",

  // Set to false to keep the bio you set on the bot's application page.
  AutomaticBioEnabled: true,

  // The footer of every embed sent by Fluxcord. Optional.
  EmbedFooterContent: "",

  // Enables Fluxcord Analytics. This will send your instance details every hour
  // to our Gatolytics instance on https://gato.fluxcord.jbcrn.dev.
  // This only sends guild counts, served user counts, total bridged messages and channels,
  // if you use a self hosted Fluxer instance or not, and the Fluxcord version.
  EnableAnalytics: false,

  // The categories that the bot will log, remove any that you don't need.
  // Categories: FLUXER, DISCORD, DB, META, VOICE, DEBUG
  LoggingCategories: ["FLUXER", "DISCORD", /*'DB',*/ "META", "VOICE"],

  // The list of MOTDs for the bot. If not specified or it is empty, it'll be disabled.
  // Examples:
  //  { name: "MOTD 1!" }
  //  { name: "MOTD 2!", emoji: "✉️" },
  //  { name: "MOTD 3!", emoji: { discord: "✉️", fluxer: { name: "customEmoji", id: "123456789000000" } } }
  // or use { nontrinsic: true } and it will use https://nontrinsic.linerly.xyz
  Motds: [],

  MaxBackfillMessages: 1000,

  // Uhm yeah backfills every message that was sent when the bot was down
  StartupSyncEnabled: false,

  // idk this is pretty obvious im not even gonna explain it
  TypingIndicatorEnabled: true,

  // The prefix of the bot
  BotPrefix: "fc!",

  // The port the voice runner WebSocket server listens on.
  RunnerWsPort: 8765,

  // Secret shared between the core bot and voice runners. Set to a long random string.
  RunnerSecret: "",

  // Healthcheck. Returns 200 when both bots are online.
  // otherwise 503. Used by Docker HEALTHCHECK / compose healthcheck.
  // Set HealthcheckEnabled to false to disable.
  // HealthcheckEnabled: true,
  // HealthcheckPort: 8080,
  // HealthcheckHost: "0.0.0.0",
  // Optional. When set, a request with "Authorization: Bearer <token>" also gets the version,
  // Discord latency, guild and shard counts, and Fluxer guild count. Without it, the response is unchanged.
  // HealthcheckToken: "",

  // Enable voice channel bridging. Manage mappings with setup and unbridge commands.
  // Requires the voice repository.
  // VoiceBridgingEnabled: false,
};

export default Config;
