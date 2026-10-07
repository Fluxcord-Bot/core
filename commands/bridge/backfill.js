import Config from "../../utils/ConfigHandler.js";
import { BridgeMap } from "../../utils/CommandHandler.js";
import { Collection, GuildChannel as DiscordGuildChannel, Message } from "discord.js";
import { Message as FluxerMessage, Channel as FluxerChannel } from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../../db/index.js";
import { Op } from "sequelize";
import { FluxerCreateMessageHandler } from "../../utils/FluxerHandler.js";
import { DiscordCreateMessageHandler } from "../../utils/DiscordHandler.js";

const activeBackfills = new Map();
const fetchPageSize = 100;
const maxBackfillMessages = 1000;

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "backfill",
  description: "Bridge existing messages in a channel",
  requireElevated: true,
  params: "[numOfMessages=10|cancel]",
  slashOptions: [
    { name: "count", type: "integer" },
    { name: "cancel", type: "boolean", flag: "cancel" },
  ],
  additionalInfo: `numOfMessages = message count starting from the last message sent, up to ${maxBackfillMessages}
cancel = interrupt the backfill currently running in this channel

Run \`bridge backfill cancel\` while a backfill is running to stop it after the current message.`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const sub = (params[0] ?? "").toLowerCase();
    if (sub === "cancel" || sub === "stop") {
      const active = activeBackfills.get(message.channelId);
      if (!active) {
        await message.reply("There is no backfill running in this channel.");
        return;
      }
      active.cancelled = true;
      await message.reply("Backfill cancellation requested. It will stop after the current message.");
      return;
    }

    let numOfMessages = Number.parseInt(params[0] || "10");
    if (Number.isNaN(numOfMessages) || numOfMessages < 1) {
      await message.reply(`Invalid message count. Usage:
\`\`\`
${Config.BotPrefix}bridge backfill [NUMBER] [cancel]
\`\`\``);
      return;
    }
    if (numOfMessages > maxBackfillMessages) {
      await message.reply(`Backfill is limited to ${maxBackfillMessages} messages at a time.`);
      return;
    }

    if (activeBackfills.has(message.channelId)) {
      await message.reply(
        `A backfill is already running in this channel. Run \`${Config.BotPrefix}bridge backfill cancel\` to stop it first.`
      );
      return;
    }

    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: {
          discordChannelId: message.channelId,
          fluxerChannelId: message.channelId,
        },
      },
    });

    if (!channelMap) {
      await message.reply(
        "This channel is not bridged. Run `" +
          Config.BotPrefix +
          "bridge setup` to setup bridging, then run bridge backfill again."
      );
      return;
    }

    const state = { cancelled: false };
    activeBackfills.set(message.channelId, state);

    try {
      const collected = [];
      let before = undefined;
      while (collected.length < numOfMessages + 2) {
        /** @type {import("@fluxerjs/collection").Collection<string, import("@fluxerjs/core").Message> | Collection<import("discord.js").Snowflake, Message>} */
        const page = await message.channel.messages.fetch({
          limit: Math.min(fetchPageSize, numOfMessages + 2 - collected.length),
          ...(before ? { before } : {}),
        });
        const values = [...page.values()];
        if (values.length === 0) break;
        collected.push(...values);
        before = values[values.length - 1].id;
        if (values.length < fetchPageSize) break;
      }

      const msgs = collected.slice(0, numOfMessages + 2);
      const ids = msgs.map(x => x.id);
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

      const matchedIds = new Set(alrBridged.flatMap(row => [row.discordMessageId, row.fluxerMessageId]));
      const unbridgedMsgs = msgs.filter(msg => !matchedIds.has(msg.id));

      const statusMsg = await message.reply(`Getting ${unbridgedMsgs.length} messages and trying to bridge them...`);

      let success = 0;
      for (const [i, msg] of unbridgedMsgs.reverse().entries()) {
        if (state.cancelled) break;
        try {
          await statusMsg.edit({
            content: `Trying to backfill message ID ${msg.id}... (${i + 1}/${unbridgedMsgs.length}, ${success} successful)`,
          });
        } catch {}
        try {
          if (msg instanceof FluxerMessage) {
            await FluxerCreateMessageHandler(msg, fluxerClient, discordClient, message.guild.id);
          } else {
            await DiscordCreateMessageHandler(msg, discordClient, fluxerClient, true);
          }
          success++;
        } catch {}
        await sleep(500);
      }

      if (state.cancelled) {
        await statusMsg.edit({
          content: `Backfill cancelled after ${success} messages.`,
        });
      } else {
        await statusMsg.edit({
          content: `🎉 Successfully backfilled ${success} messages to ${!isFluxer ? "Fluxer" : "Discord"}!`,
        });
      }
    } finally {
      if (activeBackfills.get(message.channelId) === state) {
        activeBackfills.delete(message.channelId);
      }
    }
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default command;
