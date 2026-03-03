import { EmbedBuilder } from "@fluxerjs/core";
import Config from "../config.js";
import { ChannelMap } from "../db/index.js";
import Package from "../package.json" with { type: "json" };
import { Message as FluxerMessage } from "@fluxerjs/core";
import { Op } from "sequelize";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "bridgelist",
  description: "List of bridged channels on this server/community",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    const allBridgedChannels = await ChannelMap.findAll({
      where: {
        [Op.or]: {
          discordGuildId: message.guildId,
          fluxerGuildId: message.guildId,
        },
      },
    });

    const mappedChannels = await Promise.all(
      allBridgedChannels.map(async (x) => {
        const data = x.dataValues;

        const [discordGuild, discordChannel, fluxerChannel, fluxerGuild] =
          await Promise.allSettled([
            discordClient.guilds.fetch(data.discordGuildId),
            discordClient.channels.fetch(data.discordChannelId),
            fluxerClient.channels.fetch(data.fluxerChannelId),
            fluxerClient.guilds.fetch(data.fluxerGuildId),
          ]);

        return {
          ...data,
          discordGuild:
            discordGuild.status === "fulfilled"
              ? discordGuild.value
              : undefined,
          discordChannel:
            discordChannel.status === "fulfilled"
              ? discordChannel.value
              : undefined,
          fluxerChannel:
            fluxerChannel.status === "fulfilled" ? fluxerChannel.value : null,
          fluxerGuild:
            fluxerGuild.status === "fulfilled" ? fluxerGuild.value : null,
        };
      }),
    );

    const bridgeArrow = (type) =>
      type === "both" ? "<->" : type === "fluxer2discord" ? "-->" : "<--";

    const str = mappedChannels
      .map(
        (x) =>
          `${x.fluxerChannel?.name ?? "unknown"} (${x.fluxerChannelId}) on ${x.fluxerGuild?.name ?? "unknown"} (${x.fluxerGuildId}) ` +
          `${bridgeArrow(x.bridgeType)} ` +
          `${x.discordChannel?.name ?? "unknown"} (${x.discordChannelId}) on ${x.discordGuild?.name ?? "unknown"} (${x.discordGuildId})`,
      )
      .join("\n");

    const strBuf = Buffer.from(str);

    if (message instanceof FluxerMessage) {
      await message.reply({ files: [{ name: "channels.txt", data: strBuf }] });
    } else {
      await message.reply({
        files: [new AttachmentBuilder(strBuf).setName("channels.txt")],
      });
    }
  },
};

export default command;
