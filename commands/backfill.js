import Config from "../utils/ConfigHandler.js";
import { BridgeMap } from "../utils/CommandHandler.js";
import {
  Collection,
  GuildChannel as DiscordGuildChannel,
  Message,
} from "discord.js";
import {
  Message as FluxerMessage,
  Channel as FluxerChannel,
} from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db/index.js";
import { Op } from "sequelize";
import { FluxerCreateMessageHandler } from "../utils/FluxerHandler.js";
import { DiscordCreateMessageHandler } from "../utils/DiscordHandler.js";

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  name: "backfill",
  description: "Bridge existing messages in a channel",
  requireElevated: true,
  params: "[numOfMessages=25]",
  additionalInfo: `numOfMessages = message count starting from the last message sent
  
Number of messages is limited to 100 due to Discord and Fluxer API limitations`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    let numOfMessages = Number.parseInt(params[0] || "10");
    const actualNum = numOfMessages;
    if (numOfMessages < 100) numOfMessages += 2;

    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: {
          discordChannelId: message.channelId,
          fluxerChannelId: message.channelId,
        },
      },
    });

    if (!ChannelMap) {
      await message.reply(
        "This channel is not bridged. Run `" +
          Config.BotPrefix +
          "bridge` to setup bridging, then run backfill again.",
      );
      return;
    }

    /** @type {import("@fluxerjs/collection").Collection<string, import("@fluxerjs/core").Message> | Collection<import("discord.js").Snowflake, Message>} */
    const msgs = await message.channel.messages.fetch({
      limit: numOfMessages,
    });

    const ids = Array.from(msgs.values(), (x) => x.id);
    const alrBridged = await MessageMap.findAll({
      where: {
        [Op.or]: {
          discordMessageId: {
            [Op.in]: ids,
          },
          fluxerMessageId: {
            [Op.in]: ids,
          },
        },
      },
    });

    const matchedIds = new Set(
      alrBridged.flatMap((row) => [row.discordMessageId, row.fluxerMessageId]),
    );
    const unbridgedMsgs = [...msgs.values()].filter(
      (msg) => !matchedIds.has(msg.id),
    );

    const statusMsg = await message.reply(
      `Getting ${actualNum} messages and trying to bridge them...`,
    );

    let success = 0;
    for (const [i, msg] of unbridgedMsgs.reverse().entries()) {
      try {
        await statusMsg.edit({
          content: `Trying to backfill message ID ${msg.id}... (${i + 1}/${actualNum}, ${success} successful)`,
        });
      } catch {}
      try {
        if (msg instanceof FluxerMessage) {
          await FluxerCreateMessageHandler(
            msg,
            fluxerClient,
            discordClient,
            message.guild.id,
          );
        } else {
          await DiscordCreateMessageHandler(
            msg,
            discordClient,
            fluxerClient,
            true,
          );
        }
        success++;
      } catch {}
      await sleep(500);
    }

    statusMsg.edit({
      content: `🎉 Successfully backfilled ${success} messages to ${!isFluxer ? "Fluxer" : "Discord"}!`,
    });
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default command;
