import Config from "../config.js";

const DefaultConfig = {
  FluxerAPIBaseURL: "https://api.fluxer.app",
  DataFolderPath: "/data",
  DiscordBotToken: "DISCORD_BOT_TOKEN",
  
  DiscordVoiceTokens: [],
  DiscordClientId: "0000000000000000000",
  FluxerBotToken: "FLUXER_BOT_TOKEN",
  FluxerTempEmojiGuildId: "0000000000000000000",
  AdminAccountIds: ["0000000000000000000"],
  EmbedFooterContent: "",
  LoggingCategories: ["FLUXER", "DISCORD", /*'DB',*/ "META", "VOICE"],
  BotPrefix: "fc!",
  FluxerBioStart: "",
  DiscordBioStart: "",
  AutomaticBioEnabled: true,
  DatabaseEncryptionToken: "",
  PostgresConnectionString: "",
  
  Motds: [],

  MaxBackfillMessages: 1000,

  StartupSyncEnabled: false,

  TypingIndicatorEnabled: true,

  VoiceBridgingEnabled: false,

  RunnerWsPort: 8765,
  RunnerSecret: "",

  HealthcheckEnabled: true,
  HealthcheckPort: 8080,
  HealthcheckHost: "0.0.0.0",
  HealthcheckToken: "",

  InternalAssetsPrefixUrl: "https://fluxcord.jbcrn.dev/fluxcordInternalAssets",

  EnableAnalytics: false,

  ...Config,
};

/**
 * @returns {{ id: string, token: string, FluxerAPIBaseURL: string, FluxerTempEmojiGuildId: string, FluxerBioStart: string, EmbedFooterContent: string, discovery?: string, instance?: Record<string, string> }[]}
 */
export function getFluxerInstances() {

  const rawInstances = Array.isArray(DefaultConfig.FluxerInstances) ? DefaultConfig.FluxerInstances.filter(Boolean) : [];

  if (rawInstances.length === 0) {
    return [
      {
        id: "default",
        token: DefaultConfig.FluxerBotToken,
        FluxerAPIBaseURL: DefaultConfig.FluxerAPIBaseURL,
        FluxerTempEmojiGuildId: DefaultConfig.FluxerTempEmojiGuildId,
        FluxerBioStart: DefaultConfig.FluxerBioStart,
        EmbedFooterContent: DefaultConfig.EmbedFooterContent,
        discovery: undefined,
        instance: undefined,
      },
    ];
  }

  const hasDefault = rawInstances.some(inst => (inst.id ?? "default") === "default");
  if (!hasDefault && DefaultConfig.FluxerBotToken) {
    rawInstances.unshift({
      id: "default",
      token: DefaultConfig.FluxerBotToken,
      FluxerAPIBaseURL: DefaultConfig.FluxerAPIBaseURL,
      FluxerTempEmojiGuildId: DefaultConfig.FluxerTempEmojiGuildId,
      FluxerBioStart: DefaultConfig.FluxerBioStart,
      EmbedFooterContent: DefaultConfig.EmbedFooterContent,
      discovery: undefined,
      instance: undefined,
    });
  }

  const instances = rawInstances;

  return instances.map((inst, i) => ({
    id: inst.id ?? (i === 0 ? "default" : `instance${i + 1}`),
    token: inst.token,
    FluxerAPIBaseURL: inst.FluxerAPIBaseURL ?? DefaultConfig.FluxerAPIBaseURL,
    FluxerTempEmojiGuildId: inst.FluxerTempEmojiGuildId ?? DefaultConfig.FluxerTempEmojiGuildId,
    FluxerBioStart: inst.FluxerBioStart ?? DefaultConfig.FluxerBioStart,
    EmbedFooterContent: inst.EmbedFooterContent ?? DefaultConfig.EmbedFooterContent,
    discovery: inst.discovery,
    instance: inst.instance,
  }));
}

/**
 * @param {string | undefined | null} instanceId
 */
export function getFluxerInstanceConfig(instanceId) {
  const instances = getFluxerInstances();
  if (!instanceId) {
    return instances.find(i => i.id === "default") ?? instances[0];
  }
  const found = instances.find(i => i.id === instanceId);
  if (!found) {
    throw new Error(
      `Unknown Fluxer instance "${instanceId}". Configured instances: ${instances.map(i => i.id).join(", ")}`
    );
  }
  return found;
}

export const DiscordEnabled = !!DefaultConfig.DiscordBotToken && DefaultConfig.DiscordBotToken !== "DISCORD_BOT_TOKEN";

export default DefaultConfig;
