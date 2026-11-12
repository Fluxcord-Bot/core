import { VoiceChannelMap } from "../../db/index.js";
import { Op } from "sequelize";
import { BridgeMap } from "../../utils/CommandHandler.js";
import { removeChannelBridges } from "../../utils/SetupHelper.js";

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
    if (BridgeMap.has(message.channelId)) {
      BridgeMap.delete(message.channelId);

      await message.reply("Cancelled bridging request.");
      return;
    }

    const voiceMaps = await VoiceChannelMap.findAll({
      where: {
        [Op.or]: [{ discordChannelId: message.channelId }, { fluxerChannelId: message.channelId }],
      },
    });
    if (voiceMaps.length > 0) {
      for (const voiceMap of voiceMaps) {
        await voiceMap.destroy();
      }
      await message.reply("Successfully unbridged!");
      return;
    }

    const removed = await removeChannelBridges(message.channelId, discordClient, fluxerClient);
    if (removed === 0) {
      await message.reply("This channel is already unbridged.");
      return;
    }

    await message.reply("Successfully unbridged!");
  },
};

export default command;
