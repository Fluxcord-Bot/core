import { ChannelMap, MessageMap } from "../../db/index.js";
import { Op } from "sequelize";
import { BridgeMap } from "../../utils/CommandHandler.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "remove",
  aliases: ["unbridge"],
  description: "Unbridge the current channel",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    let channelMap = await ChannelMap.findOne({
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

    if (!channelMap && message.channel?.parentId) {
      const parentRow = await ChannelMap.findOne({
        where: {
          [Op.or]: [{ fluxerChannelId: message.channel.parentId }, { discordChannelId: message.channel.parentId }],
        },
      });
      if (parentRow?.tagMap) channelMap = parentRow;
    }

    if (channelMap?.autoMirrored && channelMap.parentChannelMapId) {
      const forumRow = await ChannelMap.findOne({ where: { id: channelMap.parentChannelMapId } });
      if (forumRow?.tagMap) channelMap = forumRow;
    }

    if (!channelMap) {
      if (BridgeMap.has(message.channelId)) {
        BridgeMap.delete(message.channelId);

        await message.reply("Cancelled bridging request.");
        return;
      }

      await message.reply("This channel is already unbridged.");
      return;
    }

    if (!channelMap.autoMirrored) {
      try {
        await discordClient.deleteWebhook(channelMap.discordWebhookId, {
          token: channelMap.discordWebhookToken,
        });
      } catch {}

      try {
        const channel = /** @type {TextChannel} */ (await fluxerClient.channels.fetch(channelMap.fluxerChannelId));
        const webhooks = await channel.fetchWebhooks();
        const webhook = webhooks.find(x => x.id === channelMap.fluxerWebhookId);
        await webhook?.delete();
      } catch {}
    }

    const children = await ChannelMap.findAll({
      where: { parentChannelMapId: channelMap.id },
    });
    for (const child of children) {
      await MessageMap.destroy({ where: { channelMapId: child.id } });
      await child.destroy();
    }

    await MessageMap.destroy({ where: { channelMapId: channelMap.id } });
    await channelMap.destroy();

    await message.reply("Successfully unbridged!");
  },
};

export default command;
