import { Message, EmbedBuilder, TextChannel } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { commands } from "../utils/CommandHandler";
import { ChannelMap } from "../db";
import { Op } from "sequelize";

const command: CommandSchema = {
  name: "unbridge",
  description: "Unbridge the current channel",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: [
          {
            fluxerChannelId: message.channelId,
          },
          {
            discordChannelId: message.channelId,
          },
        ],
      },
    });

    if (!channelMap) {
      await message.reply("This channel is already unbridged.");
      return;
    }

    try {
      await discordClient.deleteWebhook(channelMap.discordWebhookId, {
        token: channelMap.discordWebhookToken,
      });
    } catch {}

    try {
      const channel = (await fluxerClient.channels.fetch(
        channelMap.fluxerChannelId,
      )) as TextChannel;
      const webhooks = await channel.fetchWebhooks();
      const webhook = webhooks.find((x) => x.id === channelMap.fluxerWebhookId);
      await webhook?.delete();
    } catch {}

    await channelMap.destroy();

    await message.reply("Successfully unbridged!");
  },
};

export default command;
