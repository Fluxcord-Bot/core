import { BridgeEndpoint, VoiceChannelMap } from "../../db/index.js";
import changeBotBio from "../../utils/ChangeBotBio.js";
import { isVoiceChannel } from "../../utils/AnnouncementPublish.js";
import { setupBridgePair } from "../../utils/SetupHelper.js";
import { mirrorTopicFromEndpoint } from "../../utils/TopicMirror.js";
import { resolveFluxerClient } from "../../utils/FluxerClients.js";

const DIRECTIONS = { d2f: "discord2fluxer", f2d: "fluxer2discord" };

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["admin", "dbg"],
  name: "forceattach",
  description: "Debug: force-bridge two channels or threads with no checks",
  requireOwner: true,
  params: "(discordChannelId) (fluxerChannelId) [both|d2f|f2d=both] [instance=default] [thread]",
  slashOptions: [
    { name: "discord_channel_id", type: "string" },
    { name: "fluxer_channel_id", type: "string" },
    { name: "direction", type: "string" },
    { name: "instance", type: "string" },
    { name: "thread", type: "boolean", flag: "thread" },
  ],
  additionalInfo: `thread - both IDs are threads; their parent channels must already be bridged to each other (direction is ignored)`,
  async run(params, message, discordClient) {
    const thread = params.includes("thread");
    const [discordId, fluxerId, dir = "both", instanceId = "default"] = params.filter(p => p !== "thread");
    const fluxerClient = resolveFluxerClient(instanceId);

    const discordChannel = await discordClient.channels.fetch(discordId);
    const fluxerChannel = await fluxerClient.channels.fetch(fluxerId);

    if (thread) {
      const [dps, fps] = await Promise.all([
        BridgeEndpoint.findAll({ where: { platform: "discord", channelId: discordChannel.parentId } }),
        BridgeEndpoint.findAll({ where: { platform: "fluxer", instanceId, channelId: fluxerChannel.parentId } }),
      ]);
      const dp = dps.find(d => fps.some(f => f.groupId === d.groupId));
      const fp = dp && fps.find(f => f.groupId === dp.groupId);
      if (!dp || !fp) {
        await message.reply("The parent channels must already be bridged to each other.");
        return;
      }

      for (const [platform, ch, parent, inst] of [
        ["discord", discordChannel, dp, "default"],
        ["fluxer", fluxerChannel, fp, instanceId],
      ]) {
        await BridgeEndpoint.create({
          platform,
          instanceId: inst,
          channelId: ch.id,
          guildId: ch.guildId,
          webhookId: null,
          webhookToken: null,
          kind: "thread",
          autoMirrored: true,
          parentEndpointId: parent.id,
          guildMapId: parent.guildMapId,
          groupId: parent.groupId,
        });
      }

      await message.reply("✅ Force-attached threads.");
      return;
    }

    const { endpoints } = await setupBridgePair(
      DIRECTIONS[dir] ?? "both",
      { platform: "discord", instanceId: "default", channel: discordChannel },
      { platform: "fluxer", instanceId, channel: fluxerChannel },
      discordClient
    );

    for (const e of endpoints) {
      const src = e.channelId === discordChannel.id ? discordChannel : fluxerChannel;
      await mirrorTopicFromEndpoint(e, src.topic ?? null, discordClient).catch(() => {});
    }

    if (isVoiceChannel(discordChannel)) {
      const d = endpoints.find(e => e.platform === "discord");
      const f = endpoints.find(e => e.platform === "fluxer");
      await VoiceChannelMap.destroy({ where: { discordChannelId: d.channelId, fluxerChannelId: f.channelId } });
      await VoiceChannelMap.create({
        discordGuildId: d.guildId,
        discordChannelId: d.channelId,
        fluxerGuildId: f.guildId,
        fluxerChannelId: f.channelId,
        fluxerInstanceId: f.instanceId,
      });
    }

    const discordGuild = discordChannel.guild ?? (await discordClient.guilds.fetch(discordChannel.guildId));
    const fluxerGuild = fluxerChannel.guild ?? (await fluxerClient.guilds.fetch(fluxerChannel.guildId));
    await changeBotBio(discordGuild);
    await changeBotBio(fluxerGuild);
    await message.reply("✅ Force-attached.");
  },
};

export default command;
