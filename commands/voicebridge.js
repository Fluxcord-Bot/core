//@ts-check
import Config from "../utils/ConfigHandler.js";
import { VoiceChannelMap, ChannelMap } from "../db/index.js";
import { ChannelType } from "discord.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "voicebridge",
  description: "Bridge a Discord voice channel to a Fluxer voice channel",
  requireElevated: true,
  params: "<discordVoiceChannelId> <fluxerVoiceChannelId>",
  async run(params, message, discordClient, fluxerClient) {
    const discordChannelId = params[0];
    const fluxerChannelId = params[1];

    if (!discordChannelId || !fluxerChannelId) {
      await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}voicebridge <discordVoiceChannelId> <fluxerVoiceChannelId>
\`\`\``);
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
      fluxerChannel = await fluxerClient.channels.fetch(fluxerChannelId);
    } catch {
      await message.reply("Fluxer channel not found.");
      return;
    }
    if (!fluxerChannel || !fluxerChannel.isVoice()) {
      await message.reply("Fluxer channel not found or is not a voice channel.");
      return;
    }

    const guildBridge = await ChannelMap.findOne({
      where: { discordGuildId: discordChannel.guildId, fluxerGuildId: fluxerChannel.guildId },
    });
    if (!guildBridge) {
      await message.reply(
        "These guilds are not bridged. Set up a text channel bridge between them first.",
      );
      return;
    }

    const existing = await VoiceChannelMap.findOne({ where: { discordChannelId } });
    if (existing) {
      await message.reply("A voice bridge for this Discord channel already exists.");
      return;
    }

    await VoiceChannelMap.create({
      discordGuildId: discordChannel.guildId,
      discordChannelId,
      fluxerGuildId: fluxerChannel.guildId,
      fluxerChannelId,
    });

    await message.reply(
      `Voice bridge created: Discord \`${discordChannelId}\` ↔ Fluxer \`${fluxerChannelId}\``,
    );
  },
};

export default command;
