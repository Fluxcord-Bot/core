import { Message as FluxerMessage } from "@fluxerjs/core";
import { Op } from "sequelize";
import { BridgeEndpoint, BridgeGroup } from "../../db/index.js";
import { resolveFluxerClient } from "../../utils/FluxerClients.js";
import { createWebhookFor, webhookNeededForTarget } from "../../utils/SetupHelper.js";
import { invalidateDiscordWebhookCache, invalidateFluxerWebhookCache } from "../../utils/Webhooks.js";
import Config from "../../utils/ConfigHandler.js";
import { withFluxerRateLimit } from "../../utils/FluxerRateLimit.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["doctor"],
  name: "rewebhook",
  aliases: ["re-webhook"],
  description: "Delete and recreate the bridge webhooks on both sides of this bridge",
  requireElevated: true,
  async run(params, message, discordClient) {
    const here = await BridgeEndpoint.findAll({
      where: { platform: message instanceof FluxerMessage ? "fluxer" : "discord", channelId: message.channelId },
    });
    if (here.length === 0) {
      await message.reply(`This channel isn't bridged. Use \`${Config.BotPrefix}bridge setup\` to bridge it first.`);
      return;
    }

    const groupIds = [...new Set(here.map(e => e.groupId))];
    const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } } });
    const endpoints = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds }, kind: "channel" } });

    const lines = [];
    for (const endpoint of endpoints) {
      const bridgeType = groups.find(g => g.id === endpoint.groupId)?.bridgeType;
      if (!bridgeType || !webhookNeededForTarget(endpoint.platform, bridgeType)) continue;

      const isFluxer = endpoint.platform === "fluxer";
      const client = isFluxer ? resolveFluxerClient(endpoint.instanceId) : discordClient;
      let label = `${isFluxer ? "Fluxer" : "Discord"} #${endpoint.channelId}`;
      try {
        const channel = await client.channels.fetch(endpoint.channelId);
        if (channel?.name) label = `${isFluxer ? "Fluxer" : "Discord"} #${channel.name}`;

        if (endpoint.webhookId) {
          try {
            if (isFluxer) {
              await withFluxerRateLimit(async () => {
                const webhooks = await channel?.fetchWebhooks();
                await webhooks?.find?.(x => x.id === endpoint.webhookId)?.delete();
              }, `webhook:${endpoint.channelId}`);
            } else {
              await discordClient.deleteWebhook(endpoint.webhookId, { token: endpoint.webhookToken ?? undefined });
            }
          } catch {}
          invalidateDiscordWebhookCache(endpoint.webhookId);
          invalidateFluxerWebhookCache(endpoint.channelId);
        }

        const webhook = await createWebhookFor(
          channel,
          endpoint.platform,
          `Fluxcord Bridge (${endpoint.channelId} (${isFluxer ? "F" : "D"}) )`
        );
        if (!webhook) {
          lines.push(`❌ ${label}: could not create a webhook (missing permissions?)`);
          continue;
        }
        endpoint.webhookId = webhook.id;
        endpoint.webhookToken = webhook.token;
        await endpoint.save();
        lines.push(`✅ ${label}: webhook recreated`);
      } catch (e) {
        lines.push(`❌ ${label}: ${e?.message ?? e}`);
      }
    }

    await message.reply(lines.length === 0 ? "This bridge's direction doesn't use webhooks." : lines.join("\n"));
  },
};

export default command;
