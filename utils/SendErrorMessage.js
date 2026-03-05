import { EmbedBuilder, Message } from "@fluxerjs/core";
import { EmbedBuilder as DiscordEmbedBuilder } from "discord.js";
import { GuildMap } from "../db/index.js";
import { log } from "./Logger.js";

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>> | Message} message
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {any} error
 * @param {boolean} [replyFallback=false]
 */
export async function sendErrorMessage(
  message,
  discordClient,
  fluxerClient,
  error,
  replyFallback = false,
) {
  const guildMap = await GuildMap.findOne({
    where: {
      guildId: message.guildId,
    },
  });

  try {
    if (guildMap) {
      if (guildMap.errorLoggingChannelId && guildMap.errorLoggingPlatform) {
        if (guildMap.errorLoggingPlatform === "fluxer") {
          const channel = await fluxerClient.channels.fetch(
            guildMap.errorLoggingChannelId,
          );

          /** @type {any} */ (channel).send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Error occurred while bridging a message")
                .addFields({
                  name: "Message",
                  value: `${message.author.globalName} in <#${message.channelId}>: ${message.content}`,
                })
                .addFields({
                  name: "Stack trace",
                  value: `${error}`,
                }),
            ],
          });
        } else {
          const channel = await discordClient.channels.fetch(
            guildMap.errorLoggingChannelId,
          );

          if (channel?.isSendable()) {
            channel.send({
              embeds: [
                new DiscordEmbedBuilder()
                  .setTitle("Error occurred while bridging a message")
                  .addFields({
                    name: "Message",
                    value: `${message.author.globalName} in <#${message.channelId}>: ${message.content}`,
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

      if (guildMap.errorReaction) {
        await message.react(guildMap.errorReaction);
      }
    } else {
      await message.react("⛓️‍💥");
    }
  } catch {}

  log(
    message instanceof Message ? "FLUXER" : "DISCORD",
    "An error occurred",
    error,
  );
}
