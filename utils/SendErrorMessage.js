import { EmbedBuilder as FluxerEmbedBuilder, Message as FluxerMessage } from "@fluxerjs/core";
import { EmbedBuilder as DiscordEmbedBuilder } from "discord.js";
import { GuildMap } from "../db/index.js";
import { log } from "./Logger.js";
import { genMsgLink } from "./GenMsgLink.js";
import { isBridgeHealthDegraded, recordBridgeFailure } from "./BridgeHealth.js";
import { instanceIdOfClient, resolveFluxerClient } from "./FluxerClients.js";

/**
 * @typedef {Object} SendErrorOptions
 * @property {string} [instanceId]
 */

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>> | FluxerMessage} message
 * @param {import("discord.js").Client} discordClient
 * @param {any} error
 * @param {SendErrorOptions} [options]
 */
export async function sendErrorMessage(message, discordClient, error, options = {}) {
  recordBridgeFailure(message.guildId);
  const suppressReaction = isBridgeHealthDegraded(message.guildId);
  const isFluxer = message instanceof FluxerMessage;
  const instanceId = options.instanceId ?? (isFluxer ? instanceIdOfClient(message.client) ?? "default" : "default");

  const maps = await GuildMap.findAll({ where: { guildId: message.guildId } });
  const guildMap = maps.find(m => (isFluxer ? true : m.guildType === "discord")) ?? null;

  try {
    if (guildMap) {
      if (guildMap.errorLoggingChannelId && guildMap.errorLoggingPlatform) {
        if (guildMap.errorLoggingPlatform === "fluxer") {
          const fluxerClient = resolveFluxerClient(instanceId);
          const channel = await fluxerClient.channels.fetch(guildMap.errorLoggingChannelId).catch(() => null);

          if (channel?.isSendable()) {
            await channel.send({
              embeds: [
                new FluxerEmbedBuilder()
                  .setTitle("Error occurred while bridging a message")
                  .addFields({
                    name: "Message",
                    value: `${message.author.globalName} (${await genMsgLink(message)}): ${message.content}`,
                  })
                  .addFields({
                    name: "Stack trace",
                    value: `${error}`,
                  }),
              ],
            });
          }
        } else {
          const channel = await discordClient.channels.fetch(guildMap.errorLoggingChannelId);

          if (channel?.isSendable()) {
            channel.send({
              embeds: [
                new DiscordEmbedBuilder()
                  .setTitle("Error occurred while bridging a message")
                  .addFields({
                    name: "Message",
                    value: `${message.author.globalName} (${await genMsgLink(message)}): ${message.content}`,
                  })
                  .addFields({
                    name: "Stack trace",
                    value: `${error}`,
                  }),
              ],
            });
          }
        }
      }

      if (guildMap.errorReaction && !suppressReaction) {
        await message.react(guildMap.errorReaction);
      }
    } else if (!suppressReaction) {
      await message.react("⛓️‍💥");
    }
  } catch {}

  log(
    isFluxer ? "FLUXER" : "DISCORD",
    `An error occurred on ${await genMsgLink(message).catch(() => "?")}`,
    error
  );
}
