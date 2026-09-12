import { GuildChannel as DiscordGuildChannel } from "discord.js";
import {
  Message as FluxerMessage,
  GuildChannel as FluxerGuildChannel,
} from "@fluxerjs/core";
import { ChannelMap, GuildMap } from "../db/index.js";
import { log } from "../utils/Logger.js";
import { BridgeMap } from "../utils/CommandHandler.js";
import changeBotBio from "../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "verify",
  description: "Verify/approve a bridge",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const bridgeMap = BridgeMap.get(message.channelId);

    const botPerms = checkBotPermissions(
      message.guild.members.me,
      message.channel,
    );

    if (!botPerms.hasAllCritical) {
      await message.reply(
        `Fluxcord doesn't have these critical permissions on this server or channel: ${[...botPerms.missingCritical, ...botPerms.missingGuildCritical].join(", ")}\nPlease add those permissions to the bot first before using this command.`,
      );
      return;
    }

    const optionalWarning =
      botPerms.missingOptional.length > 0
        ? isFluxer
          ? `\n\n> [!WARNING] The bot is missing these optional permissions here: ${botPerms.missingOptional.join(", ")}. Some things might not bridge properly.`
          : `\n\n> ⚠️ **Warning**\n> The bot is missing these optional permissions here: ${botPerms.missingOptional.join(", ")}. Some things might not bridge properly.`
        : "";

    if (!bridgeMap) {
      await message.reply(
        "This server isn't configured for bridging. Bridge this first before verifying.",
      );
      return;
    }

    const channelId = isFluxer
      ? bridgeMap.discordChannel
      : bridgeMap.fluxerChannel;
    const type = bridgeMap.bridgeType;
    let thisChannel;
    let channel;
    try {
      thisChannel = await message.client.channels.fetch(message.channelId);
      channel = await (isFluxer ? discordClient : fluxerClient).channels.fetch(
        channelId,
      );
    } catch {
      thisChannel = null;
      channel = null;
    }

    if (!thisChannel || !channel) {
      await message.reply("Channel not found. Maybe invite the bot?");
      log(
        isFluxer ? "FLUXER" : "DISCORD",
        `channel ${message.channelId} is on non expected value. report it on https://codeberg.org/jbcarreon123/fluxcord as this SHOULD NOT happen`,
      );
      return;
    }

    let fluxerWebhookId = "";
    let fluxerWebhookToken = "";
    let fluxerChannelId = "";
    let fluxerGuildId = "";
    let discordWebhookId = "";
    let discordWebhookToken = "";
    let discordChannelId = "";
    let discordGuildId = "";

    if (
      thisChannel instanceof FluxerGuildChannel &&
      type !== "FLUXER2DISCORD"
    ) {
      const webhook = await thisChannel.createWebhook({
        name: `Fluxcord Bridge (${thisChannel.id} (F) ${type === "BOTH" ? "<->" : "<--"} ${channel.id} (D))`,
      });
      fluxerWebhookToken = webhook.token ?? "";
      fluxerWebhookId = webhook.id;
      fluxerChannelId = thisChannel.id;
      fluxerGuildId = thisChannel.guildId;
    } else if (
      thisChannel instanceof DiscordGuildChannel &&
      thisChannel.isTextBased() &&
      type !== "DISCORD2FLUXER"
    ) {
      const webhook = await thisChannel.createWebhook({
        name: `Fluxcord Bridge (${thisChannel.id} (D) ${type === "BOTH" ? "<->" : "<--"} ${channel.id} (F))`,
      });
      discordWebhookToken = webhook.token;
      discordWebhookId = webhook.id;
      discordChannelId = thisChannel.id;
      discordGuildId = thisChannel.guildId;
    }

    if (channel instanceof FluxerGuildChannel && type !== "FLUXER2DISCORD") {
      const webhook = await channel.createWebhook({
        name: `Fluxcord Bridge (${channel.id} (F) ${type === "BOTH" ? "<->" : "<--"} ${thisChannel.id} (D))`,
      });
      fluxerWebhookToken = webhook.token ?? "";
      fluxerWebhookId = webhook.id;
      fluxerChannelId = channel.id;
      fluxerGuildId = channel.guildId;
    } else if (
      channel instanceof DiscordGuildChannel &&
      channel.isTextBased() &&
      type !== "DISCORD2FLUXER"
    ) {
      const webhook = await channel.createWebhook({
        name: `Fluxcord Bridge (${channel.id} (D) ${type === "BOTH" ? "<->" : "<--"} ${thisChannel.id} (F))`,
      });
      discordWebhookToken = webhook.token;
      discordWebhookId = webhook.id;
      discordChannelId = channel.id;
      discordGuildId = channel.guildId;
    }

    const fluxerGuildMap = await GuildMap.findOrCreate({
      where: {
        guildId: fluxerGuildId,
        guildType: "fluxer",
      },
    });
    const discordGuildMap = await GuildMap.findOrCreate({
      where: {
        guildId: discordGuildId,
        guildType: "discord",
      },
    });

    await ChannelMap.create({
      fluxerChannelId,
      discordChannelId,
      fluxerGuildId,
      discordGuildId,
      fluxerWebhookId,
      discordWebhookId,
      fluxerWebhookToken,
      discordWebhookToken,
      fluxerGuildMapId: fluxerGuildMap[0].id,
      discordGuildMapId: discordGuildMap[0].id,
      bridgeType: type.toLowerCase(),
    });

    let remoteOptionalWarning = "";
    try {
      const remoteMember = isFluxer
        ? await (
            await discordClient.guilds.fetch(discordGuildId)
          ).members.fetchMe()
        : await (
            await fluxerClient.guilds.fetch(fluxerGuildId)
          ).members.fetchMe();
      const remotePerms = checkBotPermissions(remoteMember, channel);
      if (remotePerms.missingOptional.length > 0) {
        remoteOptionalWarning = isFluxer
          ? `\n\n> ⚠️ **Warning**\n> The bot is missing these optional permissions here: ${remotePerms.missingOptional.join(", ")}. Some things might not bridge properly.`
          : `\n\n> [!WARNING] The bot is missing these optional permissions here: ${remotePerms.missingOptional.join(", ")}. Some things might not bridge properly.`;
      }
    } catch {}

    await channel.send({
      content:
        "🎉 This channel is now bridged to " +
        (isFluxer ? "Fluxer" : "Discord") +
        "!" +
        remoteOptionalWarning,
    });

    await message.reply({
      content:
        "🎉 This channel is now bridged to " +
        (!isFluxer ? "Fluxer" : "Discord") +
        "!" +
        optionalWarning,
    });

    if (channel.guild) await changeBotBio(channel.guild);
    if (message.guild) await changeBotBio(message.guild);
  },
};

export default command;
