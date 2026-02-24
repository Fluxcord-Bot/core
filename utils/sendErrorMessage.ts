import {
  EmbedBuilder,
  Message,
  type Client as FluxerClient,
  type TextChannel,
} from "@fluxerjs/core";
import {
  EmbedBuilder as DiscordEmbedBuilder,
  type Client as DiscordClient,
  type Message as DiscordMessage,
  type OmitPartialGroupDMChannel,
} from "discord.js";
import { ChannelMap } from "../db";
import { Op } from "sequelize";
import { log } from "./Logger";

export async function sendErrorMessage(
  message: OmitPartialGroupDMChannel<DiscordMessage<boolean>> | Message,
  discordClient: DiscordClient,
  fluxerClient: FluxerClient,
  error: any,
  replyFallback: boolean = false,
) {
  const channelMap = await ChannelMap.findOne({
    where: {
      [Op.or]: [
        {
          discordChannelId: message.channelId,
        },
        {
          fluxerChannelId: message.channelId,
        },
      ],
    },
  });

  if (channelMap) {
    if (channelMap.errorLoggingChannelId && channelMap.errorLoggingPlatform) {
      if (channelMap.errorLoggingPlatform === "fluxer") {
        const channel = await fluxerClient.channels.fetch(
          channelMap.errorLoggingChannelId,
        );

        (channel as TextChannel).send({
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
          channelMap.errorLoggingChannelId,
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
    } else {
      if (replyFallback) {
        await message.reply({
          // @ts-expect-error
          embeds: [
            new EmbedBuilder()
              .setTitle("An error has occurred while bridging this message!")
              .addFields({
                name: "Stack trace",
                value: `${error}`,
              }),
          ],
        });
      } else {
        log(
          message instanceof Message ? "FLUXER" : "DISCORD",
          "An error occurred",
          error,
        );
      }
    }
  }
}
