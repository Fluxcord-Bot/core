import { Message as FluxerMessage } from "@fluxerjs/core";
import { Op } from "sequelize";
import { BridgeEndpoint, BridgeGroup } from "../../db/index.js";
import { cloudUploadAttachments } from "../../utils/CloudUpload.js";
import { resolveFluxerClient } from "../../utils/FluxerClients.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "list",
  aliases: ["bridgelist"],
  description: "List of bridged channels on this server/community",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    const endpoints = await BridgeEndpoint.findAll({
      where: { guildId: message.guildId, kind: "channel" },
      raw: true,
    });

    const groupIds = [...new Set(endpoints.map(x => x.groupId))];
    const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } }, raw: true });
    const typeById = new Map(groups.map(g => [g.id, g.bridgeType]));

    const allGroupEndpoints = await BridgeEndpoint.findAll({
      where: { groupId: { [Op.in]: groupIds } },
      raw: true,
    });

    const lines = [];
    for (const groupId of groupIds) {
      const members = allGroupEndpoints.filter(x => x.groupId === groupId);
      const parts = await Promise.all(
        members.map(async x => {
          let name = "unknown";
          let guildName = "unknown";
          try {
            if (x.platform === "discord") {
              const channel = await discordClient.channels.fetch(x.channelId);
              name = channel?.name ?? name;
              const guild = await discordClient.guilds.fetch(x.guildId);
              guildName = guild?.name ?? guildName;
            } else {
              const channel = await resolveFluxerClient(x.instanceId).channels.fetch(x.channelId);
              name = channel?.name ?? name;
              const guild = await resolveFluxerClient(x.instanceId).guilds.fetch(x.guildId);
              guildName = guild?.name ?? guildName;
            }
          } catch {}
          return `${x.platform === "fluxer" ? "F" : "D"}#${name} (${x.channelId}) on ${guildName}${x.instanceId !== "default" ? ` [${x.instanceId}]` : ""}`;
        })
      );
      lines.push(`${typeById.get(groupId) ?? "both"}: ${parts.join(" <-> ")}`);
    }

    const str = lines.join("\n");
    const strBuf = Buffer.from(str);

    if (message instanceof FluxerMessage) {
      await message.reply({ files: [{ name: "channels.txt", data: strBuf }] });
    } else {
      await message.reply({
        attachments: await cloudUploadAttachments(discordClient, message.channel.id, [
          { attachment: strBuf, name: "channels.txt" },
        ]),
      });
    }
  },
};

export default command;
