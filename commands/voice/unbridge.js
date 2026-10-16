//@ts-check
import Config from "../../utils/ConfigHandler.js";
import { VoiceChannelMap } from "../../db/index.js";
import { Op } from "sequelize";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["voice", "v"],
  name: "unbridge",
  aliases: ["voiceunbridge"],
  description: "Remove a voice bridge by Discord or Fluxer channel ID",
  requireElevated: true,
  params: "<channelId>",
  slashOptions: [{ name: "channel_id", type: "string", required: true }],
  async run(params, message, discordClient, fluxerClient) {
    const channelId = params[0];

    if (!channelId) {
      await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}voice unbridge <channelId>
\`\`\``);
      return;
    }

    const voiceMaps = await VoiceChannelMap.findAll({
      where: {
        [Op.or]: [{ discordChannelId: channelId }, { fluxerChannelId: channelId }],
      },
    });
    if (voiceMaps.length === 0) {
      await message.reply("No voice bridge found for that channel ID.");
      return;
    }

    for (const voiceMap of voiceMaps) {
      await voiceMap.destroy();
    }
    await message.reply("Successfully unbridged!");
  },
};

export default command;
