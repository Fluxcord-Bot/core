import { EmbedBuilder, TextChannel as FluxerTextChannel } from "@fluxerjs/core";
import { MessageMap } from "../db/index.js";
import { Op, or } from "sequelize";
import { ChannelType, TextChannel } from "discord.js";
import { genMsgLink } from "./GenMsgLink.js";

/**
 * @param {import("@fluxerjs/core").Message | import("discord.js").Message} message
 * @param {import("@fluxerjs/core").User | import("discord.js").User} user
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function sendBridgeInfo(
  message,
  user,
  discordClient,
  fluxerClient,
) {
  const embed = new EmbedBuilder();
  embed.setURL(await genMsgLink(message));
  const messageMap = await MessageMap.findOne({
    where: {
      [Op.or]: {
        discordMessageId: message.id,
        fluxerMessageId: message.id,
      },
    },
    include: ["channelMap"],
  });
  if (!messageMap) return;
  const origChannel =
    messageMap.messageSource === "fluxer"
      ? await fluxerClient.channels.fetch(messageMap.channelMap.fluxerChannelId)
      : await discordClient.channels.fetch(
          messageMap.channelMap.discordChannelId,
        );
  if (!origChannel) return;
  if (origChannel instanceof FluxerTextChannel) {
    const message = await origChannel.messages.fetch(
      messageMap.fluxerMessageId,
    );
    embed.setTitle(`Message ${message.id} on #${origChannel.name}`);
    embed.setDescription(
      `[Jump to message on original platform](${await genMsgLink(message)})`,
    );
    embed.addFields({
      name: "Author",
      value: `@${message.author.username}#${message.author.discriminator} (${message.author.id})`,
      inline: true,
    });
  } else if (origChannel.isTextBased()) {
    const message = await origChannel.messages.fetch(
      messageMap.discordMessageId,
    );
    embed.setTitle(`Message ${message.id} on #${origChannel.name}`);
    embed.setDescription(
      `[Jump to message on original platform](${await genMsgLink(message)})`,
    );
    embed.addFields({
      name: "Author",
      value: `@${message.author.tag} (${message.author.id})`,
      inline: true,
    });
  }

  const dm = await user.createDM();
  await dm.send({
    embeds: [embed],
  });
}
