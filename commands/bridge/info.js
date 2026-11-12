import { Message as FluxerMessage } from "@fluxerjs/core";
import { Op } from "sequelize";
import { BridgeEndpoint, BridgeGroup } from "../../db/index.js";
import { resolveFluxerClient } from "../../utils/FluxerClients.js";
import { EmbedBuilder } from "discord.js";
import { embedFooterForMessage } from "../../utils/PerInstance.js";

const command = {
  groupNames: ["bridge", "b"],
  name: "info",
  aliases: ["bridgeinfo"],
  description: "Show what fanout group this channel is part of",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    const endpoints = await BridgeEndpoint.findAll({
      where: { platform: message instanceof FluxerMessage ? "fluxer" : "discord", channelId: message.channelId },
    });

    if (endpoints.length === 0) {
      await message.reply("This channel isn't bridged. Use `bridge setup` to bridge it first.");
      return;
    }

    const groupIds = [...new Set(endpoints.map(x => x.groupId))];
    const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } } });
    const members = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds } } });

    for (const group of groups) {
      const inGroup = members.filter(x => x.groupId === group.id);
      const thisChannel = inGroup.filter(x => x.channelId === message.channelId);

      const lines = await Promise.all(
        inGroup.map(async x => {
          const badge = x.platform === "fluxer" ? "Fluxer" : "Discord";
          const here = thisChannel.some(c => c.id === x.id) ? " **(here)**" : "";
          let name = x.channelId;
          let guildName = "";
          try {
            if (x.platform === "discord") {
              name = (await discordClient.channels.fetch(x.channelId))?.name ?? name;
              guildName = (await discordClient.guilds.fetch(x.guildId))?.name ?? "";
            } else {
              const client = resolveFluxerClient(x.instanceId);
              name = (await client.channels.fetch(x.channelId))?.name ?? name;
              guildName = (await client.guilds.fetch(x.guildId))?.name ?? "";
            }
          } catch {}
          return `- ${badge} #${name} on ${guildName}${x.instanceId !== "default" ? ` [${x.instanceId}]` : ""}${x.kind === "thread" ? " (thread)" : ""}${here}${x.webhookId ? "" : " (no webhook!)"}`;
        })
      );

      const embed = new EmbedBuilder()
        .setTitle(`Bridge group #${group.id}`)
        .setDescription(
          `Direction: \`${group.bridgeType}\`\n${inGroup.length} channel${inGroup.length === 1 ? "" : "s"} in this fanout web\n\n${lines.join("\n")}`
        )
        .setColor(0x5865f2);

      const footer = embedFooterForMessage(message);
      if (footer) embed.setFooter({ text: footer });

      await message.reply({ embeds: [embed] });
    }
  },
};

export default command;
