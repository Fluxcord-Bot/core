import { Message, EmbedBuilder, TextChannel } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { BridgeMap, commands } from "../utils/CommandHandler";
import {
  GuildChannel as DiscordGuildChannel,
  TextChannel as DiscordTextChannel,
} from "discord.js";
import {
  Message as FluxerMessage,
  Channel as FluxerChannel,
} from "@fluxerjs/core";
import { ChannelMap } from "../db";
import { Op } from "sequelize";

const command: CommandSchema = {
  name: "bridge",
  description: "Bridge a channel",
  requireElevated: true,
  params: "<channelId> <both|discord2fluxer|fluxer2discord>",
  additionalInfo: `The channelId parameter takes a channel ID of the other end's channel (e.g. if you're running it on Fluxer, it needs a Discord channel ID.)

Known issues:
- Bridge "eats" attachments, basically happens when fluxer cdn just explodes (corrupted attachment), also happens when discord cdn also explodes (missing attachment)
- Due to fluxer limitations, edits from Discord to Fluxer will not bridge
- Due to Fluxer limitations, NSFW channels cannot be bridged to Discord`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const channelId = params[0];
    const typeDef = params[1];

    if (!channelId || !typeDef) {
      await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}bridge [CHANNEL_ID] [TYPE]
\`\`\``);
      return;
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
      return;
    } else if (channel instanceof FluxerChannel && channel.isDM()) {
      await message.reply(
        "Channel type is not a text-based channel or is a DM.",
      );
      return;
    } else if (
      !(channel instanceof FluxerChannel) &&
      (!channel.isSendable() || channel.isDMBased() || !channel.isTextBased())
    ) {
      await message.reply(
        "Channel type is not a text-based channel or is a DM.",
      );
      return;
    }

    if (isFluxer) {
      const chnl = (await fluxerClient.channels.fetch(
        message.channelId,
      )) as TextChannel;
      if (chnl.nsfw) {
        await message.reply(
          "Due to Fluxer API limitations, you cannot bridge NSFW channels.",
        );
        return;
      }
    } else {
      if ((channel as TextChannel).nsfw) {
        await message.reply(
          "Due to Fluxer API limitations, you cannot bridge NSFW channels.",
        );
        return;
      }
    }

    // let fluxer fix the above bug first then uncomment this
    // if (isFluxer) {
    //   const currentChannel = (await fluxerClient.channels.fetch(
    //     message.channelId,
    //   )) as TextChannel;

    //   if (
    //     (currentChannel.nsfw && !(channel as DiscordTextChannel).nsfw) ||
    //     (!currentChannel.nsfw && (channel as DiscordTextChannel).nsfw)
    //   ) {
    //     await message.reply(
    //       "Both channels needs to be set as NSFW to bridge them.",
    //     );
    //     return;
    //   }
    // } else {
    //   const currentChannel = await discordClient.channels.fetch(
    //     message.channelId,
    //   );

    //   if (
    //     ((channel as TextChannel).nsfw &&
    //       !(currentChannel as DiscordTextChannel).nsfw) ||
    //     (!(channel as TextChannel).nsfw &&
    //       (currentChannel as DiscordTextChannel).nsfw)
    //   ) {
    //     await message.reply(
    //       "Both channels needs to be set as NSFW to bridge them.",
    //     );
    //     return;
    //   }
    // }

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
      return;
    }

    BridgeMap.set(channelId, {
      discordChannel: isFluxer ? channelId : message.channelId,
      fluxerChannel: isFluxer ? message.channelId : channelId,
      bridgeType: type,
    });

    message.reply(
      `Now, verify if you wanna bridge on the other end by using \`${Config.BotPrefix}verify\`! You have 2 minutes to do it or else it will expire.`,
    );

    //@ts-expect-error
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
  },
};

export default command;
