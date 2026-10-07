import {
  ChannelMap,
  MessageMap,
  VoiceChannelMap,
} from "../../db/index.js";
import { Op } from "sequelize";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "remove-all",
  aliases: ["unbridgeall"],
  description: "Unbridge all channels on this server/community",
  requireElevated: true,
  params: "[channelId...]",
  slashOptions: [{ name: "channel_ids", type: "string", rest: true }],
  additionalInfo: `[channelId...] - only unbridge these channel IDs, defaults to every bridged channel on this server/community`,
  async run(params, message, discordClient, fluxerClient) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    let channelMaps;
    if (params.length > 0) {
      channelMaps = await ChannelMap.findAll({
        where: {
          [Op.and]: [
            {
              [Op.or]: [
                { discordGuildId: message.guildId },
                { fluxerGuildId: message.guildId },
              ],
            },
            {
              [Op.or]: [
                { discordChannelId: { [Op.in]: params } },
                { fluxerChannelId: { [Op.in]: params } },
              ],
            },
          ],
        },
      });

      const foundIds = new Set(
        channelMaps.flatMap((x) => [x.discordChannelId, x.fluxerChannelId]),
      );
      const missing = params.filter((x) => !foundIds.has(x));
      if (missing.length > 0) {
        await message.reply(
          `These channels are not bridged on this server: ${missing.join(", ")}`,
        );
        if (channelMaps.length === 0) return;
      }
    } else {
      channelMaps = await ChannelMap.findAll({
        where: {
          [Op.or]: {
            discordGuildId: message.guildId,
            fluxerGuildId: message.guildId,
          },
        },
      });
    }

    if (channelMaps.length === 0) {
      await message.reply("There are no bridged channels to unbridge.");
      return;
    }

    const statusMsg = await message.reply(
      `Unbridging ${channelMaps.length} channels...`,
    );

    let success = 0;
    let failed = 0;
    for (const [i, channelMap] of channelMaps.entries()) {
      try {
        await statusMsg.edit({
          content: `Unbridging ${channelMap.discordChannelId} <-> ${channelMap.fluxerChannelId}... (${i + 1}/${channelMaps.length}, ${success} successful)`,
        });
      } catch {}
      try {
        await unbridgeChannel(channelMap, discordClient, fluxerClient);
        success++;
      } catch {
        failed++;
      }
    }

    await statusMsg.edit({
      content:
        `Successfully unbridged ${success} channels.` +
        (failed > 0 ? ` Failed to unbridge ${failed} channels.` : ""),
    });
  },
};

async function unbridgeChannel(channelMap, discordClient, fluxerClient) {
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

  await MessageMap.destroy({ where: { channelMapId: channelMap.id } });
  await VoiceChannelMap.destroy({
    where: {
      [Op.or]: [
        { discordChannelId: channelMap.discordChannelId },
        { fluxerChannelId: channelMap.fluxerChannelId },
      ],
    },
  });
  await channelMap.destroy();
}

export default command;
