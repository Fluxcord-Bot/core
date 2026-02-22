import { GuildChannel as DiscordGuildChannel } from "discord.js";
import {
  Message as FluxerMessage,
  GuildChannel as FluxerGuildChannel,
} from "@fluxerjs/core";
import { ChannelMap } from "../db";
import { log } from "../utils/Logger";
import type { CommandSchema } from "../utils/CommandSchema";
import { BridgeMap } from "../utils/CommandHandler";

const command: CommandSchema = {
  name: "verify",
  description: "Verify/approve a bridge",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const bridgeMap = BridgeMap.get(message.channelId);

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
    const thisChannel = await message.client.channels.fetch(message.channelId);
    const channel = await (
      isFluxer ? discordClient : fluxerClient
    ).channels.fetch(channelId);

    if (!thisChannel || !channel || !channel.isSendable()) {
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

    await channel.send({
      content:
        "🎉 This channel is now bridged to " +
        (isFluxer ? "Fluxer" : "Discord") +
        "!",
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
      bridgeType: type.toLowerCase(),
    });

    await message.reply({
      content:
        "🎉 This channel is now bridged to " +
        (!isFluxer ? "Fluxer" : "Discord") +
        "!",
    });
  },
};

export default command;
