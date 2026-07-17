import { EmbedBuilder } from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db/index.js";

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  name: "stats",
  description: "Bot statistics",
  requireElevated: false,
  requireOwner: true,
  async run(params, message, discordClient, fluxerClient) {
    const messagesBridged = await MessageMap.count();
    const channelsBridged = await ChannelMap.count();
    const discordGuildCount = discordClient.guilds.cache.size;
    const fluxerGuildCount = fluxerClient.guilds.size;
    const discordMemberCount = discordClient.guilds.cache.reduce(
      (acc, guild) => acc + guild.memberCount,
      0,
    );
    const fluxerMemberCount = fluxerClient.guilds.reduce(
      (acc, guild) => acc + guild.members.size,
      0,
    );
    await message.reply({
      embeds: [
        new EmbedBuilder().setTitle("Stats").addFields(
          {
            name: "Messages bridged",
            value: messagesBridged + "",
            inline: true,
          },
          {
            name: "Channels bridged",
            value: channelsBridged + "",
            inline: true,
          },
          {
            name: "Discord Guilds",
            value: discordGuildCount + "",
            inline: true,
          },
          {
            name: "Fluxer Guilds",
            value: fluxerGuildCount + "",
            inline: true,
          },
          {
            name: "Discord Members",
            value: discordMemberCount + "",
            inline: true,
          },
          {
            name: "Fluxer Members",
            value: fluxerMemberCount + "",
            inline: true,
          },
          {
            name: "Process PID",
            value: process.pid + "",
            inline: true,
          },
          {
            name: "Memory usage",
            value: process.memoryUsage().heapUsed + "",
            inline: true,
          },
          {
            name: "Node.js Version",
            value: process.version + "",
            inline: true,
          },
        ),
      ],
    });
  },
};

export default command;
