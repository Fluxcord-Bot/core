import Config from "../../utils/ConfigHandler.js";
import { VoiceChannelMap, BridgeEndpoint } from "../../db/index.js";
import { getFluxerClient, instanceIdOfClient } from "../../utils/FluxerClients.js";
import { ChannelType } from "discord.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["voice", "v"],
  name: "bridge",
  aliases: ["voicebridge"],
  description: "Bridge a Discord voice channel to a Fluxer voice channel",
  requireElevated: true,
  params: "<discordVoiceChannelId> <fluxerVoiceChannelId> [fluxerInstanceId]",
  slashOptions: [
    {
      name: "discord_channel",
      type: "channel",
      required: true,
      channelTypes: [ChannelType.GuildVoice],
    },
    { name: "fluxer_channel_id", type: "string", required: true },
    { name: "fluxer_instance", type: "string", required: false },
  ],
  async run(params, message, discordClient, fluxerClient) {
    const discordChannelId = params[0];
    const fluxerChannelId = params[1];
    const fluxerInstanceId = params[2] || instanceIdOfClient(fluxerClient) || "default";

    if (!discordChannelId || !fluxerChannelId) {
      await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}voice bridge <discordVoiceChannelId> <fluxerVoiceChannelId> [fluxerInstanceId]
\`\`\``);
      return;
    }

    const targetFluxerClient = getFluxerClient(fluxerInstanceId);
    if (!targetFluxerClient) {
      await message.reply(`Unknown Fluxer instance \`${fluxerInstanceId}\`.`);
      return;
    }

    let discordChannel;
    try {
      discordChannel = await discordClient.channels.fetch(discordChannelId);
    } catch {
      await message.reply("Discord channel not found.");
      return;
    }
    if (!discordChannel || discordChannel.type !== ChannelType.GuildVoice) {
      await message.reply("Discord channel not found or is not a voice channel.");
      return;
    }

    let fluxerChannel;
    try {
      fluxerChannel = await targetFluxerClient.channels.fetch(fluxerChannelId);
    } catch {
      await message.reply(`Fluxer channel not found on instance \`${fluxerInstanceId}\`.`);
      return;
    }
    if (!fluxerChannel || !fluxerChannel.isVoice()) {
      await message.reply("Fluxer channel not found or is not a voice channel.");
      return;
    }

    const discordEndpoints = /** @type {any} */ (
      await BridgeEndpoint.findAll({
        where: { platform: "discord", guildId: discordChannel.guildId, kind: "channel" },
        attributes: ["groupId"],
        raw: true,
      })
    );
    const fluxerEndpoints = /** @type {any} */ (
      await BridgeEndpoint.findAll({
        where: {
          platform: "fluxer",
          guildId: fluxerChannel.guildId,
          instanceId: fluxerInstanceId,
          kind: "channel",
        },
        attributes: ["groupId"],
        raw: true,
      })
    );
    const discordGroups = new Set(discordEndpoints.map(/** @param {any} e */ e => e.groupId));
    const guildBridge = fluxerEndpoints.some(/** @param {any} e */ e => discordGroups.has(e.groupId));
    if (!guildBridge) {
      await message.reply("These guilds are not bridged. Set up a text channel bridge between them first.");
      return;
    }

    const existing = await VoiceChannelMap.findOne({
      where: { discordChannelId, fluxerChannelId, fluxerInstanceId },
    });
    if (existing) {
      await message.reply("A voice bridge for this Discord and Fluxer channel already exists.");
      return;
    }

    await VoiceChannelMap.create({
      discordGuildId: discordChannel.guildId,
      discordChannelId,
      fluxerGuildId: fluxerChannel.guildId,
      fluxerChannelId,
      fluxerInstanceId,
    });

    await message.reply(
      `Voice bridge created: Discord \`${discordChannelId}\` ↔ Fluxer \`${fluxerInstanceId}/${fluxerChannelId}\``
    );
  },
};

export default command;
