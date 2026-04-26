//@ts-check
import Config from "../utils/ConfigHandler.js";
import { VoiceChannelMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "voiceunbridge",
  description: "Remove a voice bridge by Discord or Fluxer channel ID",
  requireElevated: true,
  params: "<channelId>",
  async run(params, message, discordClient, fluxerClient) {
    const channelId = params[0];

    if (!channelId) {
      await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}voiceunbridge <channelId>
\`\`\``);
      return;
    }

    const voiceMap = await VoiceChannelMap.findOne({
      where: {
        [Op.or]: [{ discordChannelId: channelId }, { fluxerChannelId: channelId }],
      },
    });
    if (!voiceMap) {
      await message.reply("No voice bridge found for that channel ID.");
      return;
    }

    const { discordChannelId, fluxerChannelId } = voiceMap;
    await voiceMap.destroy();
    await message.reply(
      `Voice bridge removed: Discord \`${discordChannelId}\` ↔ Fluxer \`${fluxerChannelId}\``,
    );
  },
};

export default command;
