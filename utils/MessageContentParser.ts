import { Message as FluxerMessage } from "@fluxerjs/core";
import { Message as DiscordMessage, MessageMentions } from "discord.js";
import { ChannelMap } from "../db";
import { Op } from "sequelize";

export async function parseMentions(message: DiscordMessage | FluxerMessage) {
  let res = message.content;

  if (message.mentions instanceof MessageMentions) {
    const bridgedChannels = await ChannelMap.findAll({
      where: {
        discordChannelId: {
          [Op.in]: message.mentions.channels.map((x) => x.id),
        },
      },
    });

    message.mentions.channels.forEach((v) => {
      const bridgedChannel = bridgedChannels.find(
        (x) => v.id === x.discordChannelId,
      );
      if (!v.isDMBased())
        res = res.replaceAll(
          `<#${v.id}>`,
          bridgedChannel
            ? `<#${bridgedChannel.fluxerChannelId}>`
            : `#${v.name}`,
        );
    });

    message.mentions.users.forEach((v) => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.tag}`);
    });

    message.mentions.roles.forEach((v) => {
      res = res.replaceAll(`<@&${v.id}>`, `@${v.name}`);
    });
  } else {
    const roles = message.message.mentions.forEach((v) => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.username}#${v.discriminator}`);
    });
  }

  return res;
}
