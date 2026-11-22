import Config from "../../utils/ConfigHandler.js";
import { BridgeEndpoint, MessageLink } from "../../db/index.js";
import { Op } from "sequelize";
import { Message as FluxerMessage } from "@fluxerjs/core";
import { ChannelType } from "discord.js";
import { pipelineCreate } from "../../utils/pipeline/adapters.js";
import { pendingBackfills, runBackfill } from "../../utils/BackfillQueue.js";
import { backfillMirroredThread, ensureThreadFannedOut } from "../../utils/ThreadMirror.js";

const activeBackfills = new Map();
const fetchPageSize = 100;

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
  additionalInfo: `numOfMessages = message count starting from the last message sent, up to ${Config.MaxBackfillMessages}
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
    if (numOfMessages > Config.MaxBackfillMessages) {
      await message.reply(`Backfill is limited to ${Config.MaxBackfillMessages} messages at a time.`);
      return;
    }

    if (activeBackfills.has(message.channelId)) {
      await message.reply(
        `A backfill is already running in this channel. Run \`${Config.BotPrefix}bridge backfill cancel\` to stop it first.`
      );
      return;
    }

    const endpoints = await BridgeEndpoint.findAll({
      where: { channelId: message.channelId },
      raw: true,
    });
    if (endpoints.length === 0) {
      await message.reply(
        "This channel is not bridged. Run `" +
          Config.BotPrefix +
          "bridge setup` to setup bridging, then run bridge backfill again."
      );
      return;
    }

    const state = { cancelled: false };
    activeBackfills.set(message.channelId, state);

    const guildId = message.guild.id;
    const ahead = pendingBackfills(guildId);
    if (ahead > 0) await message.reply(`Queued behind ${ahead} backfill(s) in this guild.`);

    const isParentForum =
      message.channel?.isThread?.() === false &&
      (isFluxer
        ? isFluxerForumLike(message.channel)
        : message.channel?.type === ChannelType.GuildForum || message.channel?.type === ChannelType.GuildMedia);

    await runBackfill(guildId, async () => {
      try {
        if (state.cancelled) {
          await message.reply("Backfill cancelled before it started.");
          return;
        }
        if (isParentForum) {
          await backfillForumPosts(
            message,
            isFluxer,
            endpoints,
            numOfMessages,
            state,
            guildId,
            discordClient,
            fluxerClient
          );
          return;
        }
        const collected = [];
        let before = undefined;
        while (collected.length < numOfMessages + 2) {
          /** @type {import("@fluxerjs/collection").Collection<string, import("@fluxerjs/core").Message> | import("@discordjs/collection").Collection<string, import("discord.js").Message>} */
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
        const endpointIds = endpoints.map(e => e.id);
        const alrBridged = await MessageLink.findAll({
          where: {
            messageId: { [Op.in]: ids },
            endpointId: { [Op.in]: endpointIds },
          },
        });
        const matchedIds = new Set(alrBridged.map(row => row.messageId));
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
              const endpoint = endpoints.find(e => e.platform === "fluxer") ?? endpoints[0];
              await pipelineCreate(msg, {
                instanceId: endpoint.instanceId,
                execCommands: false,
              });
            } else {
              await pipelineCreate(msg, { execCommands: false });
            }
            success++;
          } catch {}
          await sleep(2000);
        }

        if (state.cancelled) {
          await statusMsg.edit({
            content: `Backfill cancelled after ${success} messages.`,
          });
        } else {
          await statusMsg.edit({
            content: `🎉 Successfully backfilled ${success} messages!`,
          });
        }
      } finally {
        if (activeBackfills.get(message.channelId) === state) {
          activeBackfills.delete(message.channelId);
        }
      }
    });
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isFluxerForumLike(channel) {
  if (!channel) return false;
  if (typeof channel.isForum === "function" && channel.isForum()) return true;
  return typeof channel.isMedia === "function" && channel.isMedia();
}

function collectionValues(result) {
  const threads = result?.threads ?? result;
  if (!threads) return [];
  if (Array.isArray(threads)) return threads;
  if (typeof threads.values === "function") return [...threads.values()];
  return [];
}

async function fetchForumPosts(channel) {
  const active = await channel.threads.fetchActive().catch(() => null);
  const archived = await channel.threads.fetchArchived({ type: "public", limit: 100 }).catch(() => null);
  return [...collectionValues(active), ...collectionValues(archived)];
}

async function backfillForumPosts(message, isFluxer, endpoints, numOfMessages, state, guildId, discordClient, fluxerClient) {
  const platform = isFluxer ? "fluxer" : "discord";
  const instanceId = endpoints.find(e => e.platform === platform)?.instanceId ?? "default";
  const posts = (await fetchForumPosts(message.channel)).slice(0, numOfMessages);
  if (posts.length === 0) {
    await message.reply("No forum posts found to backfill.");
    return;
  }

  const statusMsg = await message.reply(`Backfilling ${posts.length} forum posts...`);
  const bridgeMessage = msg => pipelineCreate(msg, { instanceId, execCommands: false });
  let success = 0;
  for (const [i, thread] of posts.entries()) {
    if (state.cancelled) break;
    try {
      await statusMsg.edit({
        content: `Backfilling forum post ${thread.id}... (${i + 1}/${posts.length}, ${success} successful)`,
      });
    } catch {}
    try {
      const made = await ensureThreadFannedOut(thread, {
        platform,
        discordClient,
        fluxerClient,
        instanceId,
        bridgeMessage,
        backfillOptions: { immediate: true },
      });
      if (made.length > 0) {
        success++;
      } else {
        const copies = await BridgeEndpoint.count({ where: { platform, channelId: thread.id, kind: "thread" } });
        if (copies > 0) {
          await backfillMirroredThread(thread, bridgeMessage, guildId, { immediate: true });
          success++;
        }
      }
    } catch {}
    await sleep(2000);
  }

  if (state.cancelled) {
    await statusMsg.edit({ content: `Backfill cancelled after ${success} forum posts.` });
  } else {
    await statusMsg.edit({ content: `🎉 Successfully backfilled ${success} forum posts!` });
  }
}

export default command;
