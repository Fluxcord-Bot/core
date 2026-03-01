import { ChannelMap } from "../db/index.js";
import { Op } from "sequelize";
import { BridgeMap } from "../utils/CommandHandler.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
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
      if (BridgeMap.has(message.channelId)) {
        BridgeMap.delete(message.channelId);

        await message.reply("Cancelled bridging request.");
        return;
      }

      await message.reply("This channel is already unbridged.");
      return;
    }

    try {
      await discordClient.deleteWebhook(channelMap.discordWebhookId, {
        token: channelMap.discordWebhookToken,
      });
    } catch {}

    try {
      const channel = /** @type {TextChannel} */ (
        await fluxerClient.channels.fetch(channelMap.fluxerChannelId)
      );
      const webhooks = await channel.fetchWebhooks();
      const webhook = webhooks.find((x) => x.id === channelMap.fluxerWebhookId);
      await webhook?.delete();
    } catch {}

    await channelMap.destroy();

    await message.reply("Successfully unbridged!");
  },
};

export default command;
