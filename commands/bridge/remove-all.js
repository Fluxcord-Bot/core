import { channelIdsForGuild, removeChannelBridges } from "../../utils/SetupHelper.js";

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

    let channelIds;
    if (params.length > 0) {
      const guildChannelIds = new Set(await channelIdsForGuild(message.guildId));
      channelIds = params.filter(x => guildChannelIds.has(x));
      const missing = params.filter(x => !guildChannelIds.has(x));
      if (missing.length > 0) {
        await message.reply(`These channels are not bridged on this server: ${missing.join(", ")}`);
        if (channelIds.length === 0) return;
      }
    } else {
      channelIds = await channelIdsForGuild(message.guildId);
    }

    if (channelIds.length === 0) {
      await message.reply("There are no bridged channels to unbridge.");
      return;
    }

    const statusMsg = await message.reply(`Unbridging ${channelIds.length} channels...`);

    let success = 0;
    let failed = 0;
    for (const [i, channelId] of channelIds.entries()) {
      try {
        await statusMsg.edit({
          content: `Unbridging ${channelId}... (${i + 1}/${channelIds.length}, ${success} successful)`,
        });
      } catch {}
      try {
        await removeChannelBridges(channelId, discordClient, fluxerClient);
        success++;
      } catch {
        failed++;
      }
    }


    await statusMsg.edit({
      content: `Successfully unbridged ${success} channels.` + (failed > 0 ? ` Failed to unbridge ${failed} channels.` : ""),
    });
  },
};

export default command;
