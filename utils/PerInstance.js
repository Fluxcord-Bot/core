import Config, { getFluxerInstanceConfig } from "./ConfigHandler.js";
import { instanceIdOfClient } from "./FluxerClients.js";

/**
 * @param {import("@fluxerjs/core").Client | undefined | null} fluxerClient
 * @returns {ReturnType<typeof getFluxerInstanceConfig>}
 */
export function fluxerConfigOfClient(fluxerClient) {
  return getFluxerInstanceConfig(instanceIdOfClient(fluxerClient) ?? "default");
}

/**
 * @param {string | undefined | null} instanceId
 * @returns {string | undefined}
 */
export function tempEmojiGuildFor(instanceId) {
  return getFluxerInstanceConfig(instanceId ?? "default")?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId;
}

/**
 * @param {import("@fluxerjs/core").Guild | import("discord.js").Guild} guild
 * @returns {string}
 */
export function bioStartForGuild(guild) {
  const instanceId = guild?.client ? instanceIdOfClient(guild.client) : null;
  if (instanceId) {
    return getFluxerInstanceConfig(instanceId).FluxerBioStart ?? Config.FluxerBioStart;
  }
  return Config.DiscordBioStart ?? "";
}

/**
 * @param {import("@fluxerjs/core").Message | import("discord.js").Message} message
 * @returns {string}
 */
export function embedFooterForMessage(message) {
  const instanceId = message?.client ? instanceIdOfClient(message.client) : null;
  if (instanceId) {
    return getFluxerInstanceConfig(instanceId).EmbedFooterContent ?? Config.EmbedFooterContent ?? "";
  }
  return Config.EmbedFooterContent ?? "";
}
