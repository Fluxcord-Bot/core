import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
  GuildChannel as DiscordGuildChannel,
} from "discord.js";
import {
  Message as FluxerMessage,
  Client as FluxerClient,
  Channel as FluxerChannel,
  GuildChannel as FluxerGuildChannel,
} from "@fluxerjs/core";
import Config from "../config";
import { ChannelMap } from "../db";
import { log } from "./Logger";
import { Op } from "sequelize";
import ExpiryMap from "expiry-map";

let BridgeMap: ExpiryMap<
  string,
  {
    discordChannel: string;
    fluxerChannel: string;
    bridgeType: string;
  }
> = new ExpiryMap(120000);

export async function CommandHandler(
  message: FluxerMessage | OmitPartialGroupDMChannel<DiscordMessage<boolean>>,
  discordClient: DiscordClient,
  fluxerClient: FluxerClient
) {
  const cmdList = message.content.split(" ");
  const command = cmdList[0]?.replace(Config.BotPrefix, "");
  const params = cmdList.slice(1);

  switch (command) {
    case "help": {
      await message.reply(`
Fluxcord is a bridge that bridges a Discord channel and a Fluxer channel.
Prefix is \`${Config.BotPrefix}\`. To use this bot, you will need the Manage Server/Community permission.

Commands:
\`${Config.BotPrefix}help\`: Shows this message
\`${Config.BotPrefix}bridge\`: Bridges a Discord channel and a Fluxer channel
\`${Config.BotPrefix}unbridge\`: Unbridges a Discord channel and a Fluxer channel

Additional parameters:
Bridge a Discord channel/Fluxer community:
\`\`\`
${Config.BotPrefix}bridge [CHANNEL_ID] [TYPE]
[CHANNEL_ID] - The channel ID of the channel you want to
               bridge from the other side. On discord,
               specify the Fluxer channel, and on Fluxer,
               specify the Discord channel ID.
[TYPE]       - The type of bridge. Can be DISCORD2FLUXER,
               FLUXER2DISCORD, or BOTH. Not case-sensitive.
               Default is BOTH if not specified.
\`\`\`
`);
      break;
    }
    case "bridge": {
      let isFluxer = message instanceof FluxerMessage;
      const channelId = params[0];
      const typeDef = params[1];

      if (!channelId || !typeDef) {
        await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}bridge [CHANNEL_ID] [TYPE]
\`\`\``);
        break;
      }

      const type = typeDef.toUpperCase() as
        | "DISCORD2FLUXER"
        | "FLUXER2DISCORD"
        | "BOTH";

      const channel = await (
        isFluxer ? discordClient : fluxerClient
      ).channels.fetch(channelId);

      if (!channel) {
        await message.reply("Channel not found. Maybe invite the bot?");
        break;
      } else if (
        channel instanceof FluxerChannel &&
        (!channel.isSendable() || channel.isDM())
      ) {
        await message.reply(
          "Channel type is not a text-based channel or is a DM.",
        );
        break;
      } else if (
        !(channel instanceof FluxerChannel) &&
        (!channel.isSendable() || channel.isDMBased() || !channel.isTextBased())
      ) {
        await message.reply(
          "Channel type is not a text-based channel or is a DM.",
        );
        break;
      }

      const channelMap = await ChannelMap.findOne({
        where: {
          [Op.or]: [
            {
              fluxerChannelId: channelId,
            },
            {
              discordChannelId: channelId,
            },
            {
              fluxerChannelId: message.channelId,
            },
            {
              discordChannelId: message.channelId,
            },
          ],
        },
      });

      if (channelMap || BridgeMap.has(channelId)) {
        await message.reply(
          "This channel is already bridged. Run `" +
            Config.BotPrefix +
            "unbridge` to unbridge, then configure it again.",
        );
        break;
      }

      BridgeMap.set(channelId, {
        discordChannel: isFluxer ? channelId : message.channelId,
        fluxerChannel: isFluxer ? message.channelId : channelId,
        bridgeType: type,
      });

      message.reply(
        `Now, verify if you wanna bridge on the other end by using \`${Config.BotPrefix}verify\`! You have 2 minutes to do it or else it will expire.`,
      );

      channel.send({
        content: `${isFluxer ? "Fluxer" : "Discord"} channel ${
          message.channel instanceof FluxerChannel
            ? message.channel.name
            : message.channel instanceof DiscordGuildChannel
              ? message.channel.name
              : ""
        } on ${isFluxer ? "community" : "server"} ${message.guild?.name} wants to bridge to this channel.

To approve the bridge, run \`${Config.BotPrefix}verify\`! If not, just ignore this message and it will be cancelled after 2 minutes.`,
      });

      break;
    }
    case "verify": {
      let isFluxer = message instanceof FluxerMessage;
      const bridgeMap = BridgeMap.get(message.channelId);

      if (!bridgeMap) {
        await message.reply(
          "This server isn't configured for bridging. Bridge this first before verifying.",
        );
        break;
      }

      const channelId = isFluxer
        ? bridgeMap.discordChannel
        : bridgeMap.fluxerChannel;
      const type = bridgeMap.bridgeType;
      const thisChannel = await message.client.channels.fetch(
        message.channelId,
      );
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
    }
  }
}
