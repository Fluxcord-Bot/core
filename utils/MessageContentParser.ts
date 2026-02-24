import {
  Message as FluxerMessage,
  Client as FluxerClient,
} from "@fluxerjs/core";
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
  } else if (message.client instanceof FluxerClient) {
    res = await parseRolesAndChannels(
      res,
      message.guildId ?? "",
      message.client,
    );

    message.mentions.forEach((v) => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.username}#${v.discriminator}`);
    });
  }

  return res;
}

async function parseRolesAndChannels(
  content: string,
  guildId: string,
  fluxerClient: FluxerClient,
) {
  const guild = await fluxerClient.guilds.fetch(guildId);

  let res = content;

  if (guild) {
    const roles = await guild.fetchRoles();
    const channels = await guild.fetchChannels();

    roles.forEach((v) => {
      res = res.replaceAll(`<@&${v.id}>`, `@${v.name}`);
    });

    const bridgedChannels = await ChannelMap.findAll({
      where: {
        fluxerChannelId: {
          [Op.in]: channels.map((x) => x.id),
        },
      },
    });

    channels.forEach((v) => {
      const bridgedChannel = bridgedChannels.find(
        (x) => v.id === x.fluxerChannelId,
      );
      res = res.replaceAll(
        `<#${v.id}>`,
        bridgedChannel ? `<#${bridgedChannel.discordChannelId}>` : `#${v.name}`,
      );
    });
  }

  return res;
}
