//@ts-check
import { Events as FluxerEvents, Client as FluxerClient, ChannelType as FluxerChannelType } from "@fluxerjs/core";
import {
  Client as DiscordClient,
  Events as DiscordEvents,
  GatewayIntentBits,
  Partials,
  ChannelType as DiscordChannelType,
} from "discord.js";
import Config from "./utils/ConfigHandler.js";
import {
  FluxerBulkDeleteMessageHandler,
  FluxerCreateMessageHandler,
  FluxerDeleteMessageHandler,
  FluxerPinsUpdateHandler,
  FluxerUpdateMessageHandler,
} from "./utils/FluxerHandler.js";
import {
  DiscordBulkDeleteMessageHandler,
  DiscordCreateMessageHandler,
  DiscordDeleteMessageHandler,
  DiscordPinsUpdateHandler,
  DiscordUpdateMessageHandler,
} from "./utils/DiscordHandler.js";
import { log } from "./utils/Logger.js";
import fs from "node:fs";
import { Op } from "sequelize";
import { ChannelMap, GuildMap, MessageMap } from "./db/index.js";
import {
  autoBridgeDiscordThread,
  autoBridgeFluxerThread,
  cleanupMirroredRow,
  mapTagsToDiscord,
  mapTagsToFluxer,
  isSelfCreate,
  selfCreatedThreads,
  syncForumTags,
} from "./utils/ThreadMirror.js";
import { isBridgeToggleEnabled } from "./utils/BridgeToggle.js";
import { sendErrorMessage } from "./utils/SendErrorMessage.js";
import { genAuthLink, renderBox } from "./utils/GenAuthLink.js";
import { setupReactionHandling } from "./utils/ReactionHandler.js";
import { setupHealthcheck } from "./utils/HealthCheck.js";
import { ensureLoadingEmojis } from "./utils/LoadingEmojiSetup.js";
import { registerDiscordCommands, setupDiscordCommands } from "./utils/DiscordCommands.js";
import { buildDiscordUserAgentSuffix, buildExtHttpUserAgent, buildFluxerUserAgent } from "./utils/UserAgent.js";

const discordClient = new DiscordClient({
  rest: {
    timeout: 30_000,
    userAgentAppendix: buildDiscordUserAgentSuffix(),
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

export const botStartingTime = new Date();

const maps = await ChannelMap.findAll();

const fluxerClient = new FluxerClient({
  rest: {
    api: Config.FluxerAPIBaseURL,
    userAgent: buildFluxerUserAgent(),
  },
  presence: {
    status: "online",
    customStatus: {
      text: `${Config.BotPrefix}help | bridging ${maps.length} channel${maps.length > 1 ? "s" : ""}`,
    },
  },
  cache: {
    guilds: Infinity,
    channels: Infinity, // <- rmember when i said its cache bruh
  },
});

fluxerClient.on(FluxerEvents.Error, error => {
  log("FLUXER", error);
});

/**
 * @param {{ discordChannelId?: string, fluxerChannelId?: string, discordGuildId?: string }} where
 */
async function destroyChannelMaps(where) {
  const channelMaps = await ChannelMap.findAll({
    where,
    attributes: ["id"],
  });
  const ids = channelMaps.map(c => c.get("id"));
  if (ids.length > 0) {
    const children = await ChannelMap.findAll({
      where: { parentChannelMapId: { [Op.in]: ids } },
    });
    const childIds = children.map(c => c.get("id"));
    if (childIds.length > 0) {
      await MessageMap.destroy({ where: { channelMapId: { [Op.in]: childIds } } });
    }
    await MessageMap.destroy({
      where: { channelMapId: ids },
    });
    if (childIds.length > 0) {
      await ChannelMap.destroy({ where: { id: { [Op.in]: childIds } } });
    }
  }
  await ChannelMap.destroy({ where });
}

discordClient.on(DiscordEvents.GuildDelete, async guild => {
  if (!guild.available) return;

  try {
    await destroyChannelMaps({ discordGuildId: guild.id });
    await GuildMap.destroy({
      where: {
        guildId: guild.id,
      },
    });
  } catch (e) {
    log("DB", `GuildDelete cleanup failed for guild ${guild.id}`, e);
  }
});

discordClient.on(DiscordEvents.ChannelDelete, async chnl => {
  try {
    await destroyChannelMaps({ discordChannelId: chnl.id });
  } catch (e) {
    log("DB", `ChannelDelete cleanup failed for discord channel ${chnl.id}`, e);
  }
});

discordClient.on(DiscordEvents.ThreadCreate, async (thread, newlyCreated) => {
  log(
    "DEBUG",
    `Discord ThreadCreate event id=${thread.id} type=${thread.type} newlyCreated=${newlyCreated} parent=${thread.parentId}`
  );
  if (selfCreatedThreads.has("discord:" + thread.id)) return;
  try {
    if (await isSelfCreate(`discord:${thread.parentId}`, thread.id)) {
      log("DEBUG", `Discord ThreadCreate self-create skip id=${thread.id}`);
      return;
    }
    if (thread.type === DiscordChannelType.PrivateThread) return;
    if (!newlyCreated && Date.now() - (thread.createdTimestamp ?? 0) > 300_000) return;
    const parentMap = await ChannelMap.findOne({
      where: { discordChannelId: thread.parentId },
      raw: true,
    });
    if (!parentMap || /** @type {any} */ (parentMap).bridgeType === "fluxer2discord") return;
    await autoBridgeDiscordThread(thread, parentMap, discordClient, fluxerClient);
  } catch (e) {
    log("FLUXER", `Failed to auto-bridge Discord thread ${thread.id}`, e);
  }
});

discordClient.on(DiscordEvents.ThreadDelete, async thread => {
  try {
    const row = /** @type {any} */ (
      await ChannelMap.findOne({
        where: { discordChannelId: thread.id },
      })
    );
    if (row?.autoMirrored) await cleanupMirroredRow(row, discordClient, fluxerClient, "discord");
    await destroyChannelMaps({ discordChannelId: thread.id });
  } catch (e) {
    log("DB", `ThreadDelete cleanup failed for discord thread ${thread.id}`, e);
  }
});

discordClient.on(DiscordEvents.ThreadUpdate, async (oldThread, newThread) => {
  try {
    const nameChanged = oldThread.name !== newThread.name;
    const tagsChanged = JSON.stringify(oldThread.appliedTags ?? []) !== JSON.stringify(newThread.appliedTags ?? []);
    if (!nameChanged && !tagsChanged) return;
    const row = /** @type {any} */ (
      await ChannelMap.findOne({
        where: { discordChannelId: newThread.id },
      })
    );
    if (!row?.autoMirrored) return;
    const fluxerThread = await fluxerClient.channels.fetch(row.fluxerChannelId);
    if (!fluxerThread || typeof fluxerThread.isThread !== "function" || !fluxerThread.isThread()) return;
    if (nameChanged) {
      try {
        await fluxerThread.edit({ name: newThread.name.slice(0, 100) });
      } catch (e) {
        log("FLUXER", `Failed to rename mirrored Fluxer thread ${row.fluxerChannelId}`, e);
      }
    }
    if (tagsChanged) {
      const parentRow = row.parentChannelMapId
        ? await ChannelMap.findOne({ where: { id: row.parentChannelMapId }, raw: true })
        : null;
      if (/** @type {any} */ (parentRow)?.tagMap) {
        let discordParent = null;
        try {
          discordParent = newThread.parentId ? await discordClient.channels.fetch(newThread.parentId) : null;
        } catch {}
        const sourceIds = newThread.appliedTags ?? [];
        const mapped = await mapTagsToFluxer(parentRow, sourceIds, discordParent, fluxerThread);
        if (mapped.length > 0 || sourceIds.length === 0) {
          try {
            await fluxerThread.edit({ appliedTags: mapped });
          } catch (e) {
            log("FLUXER", `Failed to update tags on mirrored Fluxer thread ${row.fluxerChannelId}`, e);
          }
        }
      }
    }
  } catch (e) {
    log("FLUXER", `Failed to mirror Discord thread update ${newThread.id}`, e);
  }
});

discordClient.on(DiscordEvents.ChannelUpdate, async (oldChannel, newChannel) => {
  if (newChannel.type !== DiscordChannelType.GuildForum && newChannel.type !== DiscordChannelType.GuildMedia) return;
  try {
    await syncForumTags(newChannel, "discord", discordClient, fluxerClient);
  } catch (e) {
    log("FLUXER", `Failed to sync forum tags for Discord forum ${newChannel.id}`, e);
  }
});

discordClient.on(DiscordEvents.TypingStart, async type => {
  if (type.user.id === discordClient.user?.id) return;

  try {
    const channelMap = await ChannelMap.findOne({
      where: {
        discordChannelId: type.channel.id,
      },
    });

    if (!channelMap || !(await isBridgeToggleEnabled(channelMap, "typingEnabled"))) return;

    const channel = await fluxerClient.channels.fetch(
      //@ts-expect-error
      channelMap.fluxerChannelId
    );
    await channel.sendTyping();
  } catch (e) {
    log("DISCORD", "Failed to relay typing indicator:", e);
  }
});

discordClient.on(DiscordEvents.MessageCreate, async msg => {
  if (msg.author.id === discordClient.user?.id) return;
  try {
    await DiscordCreateMessageHandler(msg, discordClient, fluxerClient);
  } catch (e) {
    await sendErrorMessage(msg, discordClient, fluxerClient, e, true);
  }
});

discordClient.on(DiscordEvents.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    await DiscordUpdateMessageHandler(oldMsg, newMsg, fluxerClient);
  } catch (e) {
    await sendErrorMessage(newMsg, discordClient, fluxerClient, e);
  }
});

discordClient.on(DiscordEvents.MessageDelete, async msg => {
  try {
    await DiscordDeleteMessageHandler(msg, fluxerClient);
  } catch (e) {
    log("FLUXER", e);
  }
});

discordClient.on(DiscordEvents.MessageBulkDelete, async msgs => {
  try {
    await DiscordBulkDeleteMessageHandler(msgs, fluxerClient);
  } catch (e) {
    log("FLUXER", e);
  }
});

discordClient.on(DiscordEvents.ChannelPinsUpdate, async channel => {
  try {
    await DiscordPinsUpdateHandler(channel, fluxerClient);
  } catch (e) {
    log("FLUXER", e);
  }
});

// prob contributed on the sudden deletions, will comment this for now
// fluxerClient.on(FluxerEvents.GuildDelete, async (guild) => {
//   if (guild.unavailable) return;

//   await GuildMap.destroy({
//     where: {
//       guildId: guild.id
//     }
//   })
// })

fluxerClient.on(FluxerEvents.ChannelDelete, async chnl => {
  try {
    await destroyChannelMaps({ fluxerChannelId: chnl.id });
  } catch (e) {
    log("DB", `ChannelDelete cleanup failed for fluxer channel ${chnl.id}`, e);
  }
});

fluxerClient.on(FluxerEvents.ThreadCreate, async thread => {
  log("DEBUG", `Fluxer ThreadCreate event id=${thread.id} type=${thread.type} parent=${thread.parentId}`);
  if (selfCreatedThreads.has("fluxer:" + thread.id)) return;
  try {
    if (await isSelfCreate(`fluxer:${thread.parentId}`, thread.id)) {
      log("DEBUG", `Fluxer ThreadCreate self-create skip id=${thread.id}`);
      return;
    }
    if (thread.type === FluxerChannelType.PrivateThread) return;
    const parentMap = await ChannelMap.findOne({
      where: { fluxerChannelId: thread.parentId },
      raw: true,
    });
    if (!parentMap || /** @type {any} */ (parentMap).bridgeType === "discord2fluxer") return;
    await autoBridgeFluxerThread(thread, parentMap, discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", `Failed to auto-bridge Fluxer thread ${thread.id}`, e);
  }
});

fluxerClient.on(FluxerEvents.ThreadDelete, async thread => {
  try {
    const row = /** @type {any} */ (
      await ChannelMap.findOne({
        where: { fluxerChannelId: thread.id },
      })
    );
    if (row?.autoMirrored) await cleanupMirroredRow(row, discordClient, fluxerClient, "fluxer");
    await destroyChannelMaps({ fluxerChannelId: thread.id });
  } catch (e) {
    log("DB", `ThreadDelete cleanup failed for fluxer thread ${thread.id}`, e);
  }
});

fluxerClient.on(FluxerEvents.ThreadUpdate, async (oldThread, newThread) => {
  try {
    const nameChanged = oldThread.name !== newThread.name;
    const tagsChanged =
      JSON.stringify(/** @type {any} */ (oldThread).appliedTags ?? []) !== JSON.stringify(newThread.appliedTags ?? []);
    if (!nameChanged && !tagsChanged) return;
    const row = /** @type {any} */ (
      await ChannelMap.findOne({
        where: { fluxerChannelId: newThread.id },
      })
    );
    if (!row?.autoMirrored) return;
    const discordThread = await discordClient.channels.fetch(row.discordChannelId);
    if (!discordThread?.isThread?.()) return;
    if (nameChanged) {
      try {
        await discordThread.setName((newThread.name ?? "").slice(0, 100));
      } catch (e) {
        log("DISCORD", `Failed to rename mirrored Discord thread ${row.discordChannelId}`, e);
      }
    }
    if (tagsChanged) {
      const parentRow = row.parentChannelMapId
        ? await ChannelMap.findOne({ where: { id: row.parentChannelMapId }, raw: true })
        : null;
      if (/** @type {any} */ (parentRow)?.tagMap) {
        let fluxerParent = null;
        try {
          fluxerParent = newThread.parentId ? await fluxerClient.channels.fetch(newThread.parentId) : null;
        } catch {}
        const sourceIds = newThread.appliedTags ?? [];
        const mapped = await mapTagsToDiscord(parentRow, sourceIds, fluxerParent, discordThread);
        if (mapped.length > 0 || sourceIds.length === 0) {
          try {
            await discordThread.setAppliedTags(mapped);
          } catch (e) {
            log("DISCORD", `Failed to update tags on mirrored Discord thread ${row.discordChannelId}`, e);
          }
        }
      }
    }
  } catch (e) {
    log("DISCORD", `Failed to mirror Fluxer thread update ${newThread.id}`, e);
  }
});

fluxerClient.on(FluxerEvents.ChannelUpdate, async (oldChannel, newChannel) => {
  const isForum = typeof newChannel.isForum === "function" && newChannel.isForum();
  const isMedia = typeof newChannel.isMedia === "function" && newChannel.isMedia();
  if (!isForum && !isMedia) return;
  try {
    await syncForumTags(newChannel, "fluxer", discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", `Failed to sync forum tags for Fluxer forum ${newChannel.id}`, e);
  }
});

fluxerClient.on(FluxerEvents.MessageCreate, async msg => {
  try {
    if (msg.author.id === fluxerClient.user?.id) return;
    await FluxerCreateMessageHandler(msg, fluxerClient, discordClient);
  } catch (e) {
    await sendErrorMessage(msg, discordClient, fluxerClient, e, true);
  }
});
fluxerClient.on(FluxerEvents.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    await FluxerUpdateMessageHandler(oldMsg, newMsg, discordClient);
  } catch (e) {
    if (newMsg.partial) {
      log("FLUXER", "An error occurred", e);
    } else {
      await sendErrorMessage(newMsg, discordClient, fluxerClient, e);
    }
  }
});
fluxerClient.on(FluxerEvents.MessageDelete, async msg => {
  try {
    await FluxerDeleteMessageHandler(msg, discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.MessageDeleteBulk, async msgs => {
  try {
    await FluxerBulkDeleteMessageHandler(msgs, discordClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.ChannelPinsUpdate, async chnl => {
  try {
    await FluxerPinsUpdateHandler(chnl, discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.TypingStart, async type => {
  if (type.userId === fluxerClient.user?.id) return;

  try {
    const channelMap = await ChannelMap.findOne({
      where: {
        fluxerChannelId: type.channelId,
      },
    });

    if (!channelMap || !(await isBridgeToggleEnabled(channelMap, "typingEnabled"))) return;

    const channel = await discordClient.channels.fetch(
      //@ts-expect-error
      channelMap.discordChannelId
    );
    if (channel && channel.isSendable()) await channel.sendTyping();
  } catch (e) {
    log("FLUXER", "Failed to relay typing indicator:", e);
  }
});

let discordReady = false;
let fluxerReady = false;
/** @type {null | (() => void)} */
let startVoiceRecovery = null;

/** @param {unknown} error */
function isRecoverableRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (!message) return false;

  if (message.includes("Used disallowed intents")) {
    renderBox([
      "Message Content Intent not enabled!",
      "On Discord Developer Portal, go to the Fluxcord bot you created,",
      'then the Bot section, then enable "Message Content Intent".',
      "",
      "To avoid footguns because of this, Fluxcord will shut down itself.",
      "You can start it later with `docker compose up -d`.",
      "",
      "Please join jb's unlabeled capacitor for support:",
      "https://fluxer.gg/jbcrn",
    ]);
    process.exit(0);
  }

  return [
    "WebSocket error",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "Connect Timeout Error",
    "Rate limited",
    "Missing Permissions",
    "Missing Access",
    "You don't have the permissions",
    "_RateLimitError",
  ].some(needle => message.includes(needle));
}

async function onBothReady() {
  if (!fs.existsSync(Config.DataFolderPath + "/fluxcord.json")) {
    log("META", "Welcome to Fluxcord! Doing first-time setup...");
    try {
      const replyLRes = await fetch(Config.InternalAssetsPrefixUrl + "/reply-l.webp", {
        headers: {
          "User-Agent": buildExtHttpUserAgent(),
        },
      });
      const replyRRes = await fetch(Config.InternalAssetsPrefixUrl + "/reply-r.webp", {
        headers: {
          "User-Agent": buildExtHttpUserAgent(),
        },
      });
      const replyL = Buffer.from(await replyLRes.arrayBuffer());
      const replyR = Buffer.from(await replyRRes.arrayBuffer());

      const fluxerGuild = await fluxerClient.guilds.fetch(Config.FluxerTempEmojiGuildId);
      try {
        await fluxerGuild?.createEmojisBulk([
          {
            // @ts-ignore
            image: replyL.toString("base64"),
            name: "reply_l",
          },
          {
            // @ts-ignore
            image: replyR.toString("base64"),
            name: "reply_r",
          },
        ]);
      } catch {}

      const fluxerEmojiReplyL = await fluxerClient.resolveEmoji(":reply_l:", Config.FluxerTempEmojiGuildId);
      const fluxerEmojiReplyR = await fluxerClient.resolveEmoji(":reply_r:", Config.FluxerTempEmojiGuildId);

      let discordEmojiReplyL;
      try {
        discordEmojiReplyL = await discordClient.application?.emojis.create({
          attachment: replyL,
          name: "reply_l",
        });
      } catch {}

      let discordEmojiReplyR;
      try {
        discordEmojiReplyR = await discordClient.application?.emojis.create({
          attachment: replyR,
          name: "reply_r",
        });
      } catch {}

      if (!discordEmojiReplyL || !discordEmojiReplyR) {
        const existing = await discordClient.application?.emojis.fetch();
        discordEmojiReplyL ??= existing?.find(e => e.name === "reply_l");
        discordEmojiReplyR ??= existing?.find(e => e.name === "reply_r");
      }

      fs.writeFileSync(
        Config.DataFolderPath + "/fluxcord.json",
        JSON.stringify({
          autoGenerated: "This file is automatically generated by Fluxcord. Please do not touch it!",
          fluxerReplyEmoji: {
            replyL: fluxerEmojiReplyL,
            replyR: fluxerEmojiReplyR,
          },
          discordReplyEmoji: {
            replyL: discordEmojiReplyL?.id,
            replyR: discordEmojiReplyR?.id,
          },
        })
      );
      log("META", "First time setup done! Enjoy using the bot!");
    } catch (e) {
      log("META", "For jb (or Fluxcord team), error is:", e);
      renderBox([
        "First time setup failed!",
        "",
        "To avoid footguns because of this, Fluxcord will shut down itself.",
        "You can start it later with `docker compose up -d`.",
        "",
        "Please join jb's unlabeled capacitor for support:",
        "https://fluxer.gg/jbcrn",
      ]);
      process.exit(0);
    }
  } else {
    try {
      const r = fs.readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8");
      const t = JSON.parse(r);
      if (
        !t.fluxerReplyEmoji ||
        !t.fluxerReplyEmoji.replyL ||
        !t.fluxerReplyEmoji.replyR ||
        !t.discordReplyEmoji ||
        !t.discordReplyEmoji.replyL ||
        !t.discordReplyEmoji.replyR
      ) {
        throw new Error(`Corrupted field on fluxcord.json, full file: ${r}`);
      }
    } catch (e) {
      log("META", "For jb (or Fluxcord team), error is:", e);
      renderBox([
        "Corrupted fluxcord.json found!",
        "",
        "To avoid footguns because of this, Fluxcord will shut down itself.",
        "You can start it later with `docker compose up -d`.",
        "",
        "Please join jb's unlabeled capacitor for support:",
        "https://fluxer.gg/jbcrn",
      ]);
      process.exit(0);
    }
  }

  try {
    await ensureLoadingEmojis(discordClient, fluxerClient);
  } catch (e) {
    log("META", "Loading emoji setup failed, early bridge placeholders will use fallback markers.", e);
  }

  if (
    Config.Motds &&
    ((Config.Motds.length > 0 &&
      // @ts-ignore
      Config.Motds.every(x => !!x)) ||
      // @ts-ignore
      Config.Motds === "nontrinsic")
  ) {
    setInterval(
      async () => {
        await motdLoop();
      },
      10 * 60 * 1000
    );
    await motdLoop();
  }

  renderBox([
    "To invite Fluxcord to your server, here's the invite links:",
    "",
    "Discord:",
    await genAuthLink(Config.DiscordClientId),
    "",
    "Fluxer:",
    await genAuthLink(fluxerClient.user?.id, true),
  ]);

  startVoiceRecovery?.();
}

fluxerClient.on(FluxerEvents.Ready, async () => {
  log("FLUXER", `${fluxerClient.user?.username}#${fluxerClient.user?.discriminator} is ready!`);

  fluxerClient.user?.setPresence({
    status: "online",
    customStatus: {
      text: `${Config.BotPrefix}help | bridging ${maps.length} channel${maps.length > 1 ? "s" : ""}`,
    },
  });

  fluxerReady = true;
  if (discordReady) onBothReady();
});

discordClient.on(DiscordEvents.ClientReady, async () => {
  log("DISCORD", `${discordClient.user?.tag} is ready!`);

  try {
    await registerDiscordCommands(discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", "Failed to register application commands:", e);
  }

  discordClient.user?.setActivity(`${Config.BotPrefix}help | bridging ${maps.length} channel${maps.length > 1 ? "s" : ""}`);

  discordReady = true;
  if (fluxerReady) onBothReady();
});

process.on("uncaughtException", error => {
  log("META", "A uncaught exception occurred.", error);

  if (isRecoverableRuntimeError(error)) {
    log("META", "Ignoring recoverable runtime error and keeping the process alive.");
    return;
  }

  try {
    discordClient.destroy();
  } catch {}

  try {
    fluxerClient.destroy();
  } catch {}

  process.exit(1);
});

// @ts-ignore
process.on(
  "unhandledRejection",
  /** @param {unknown} reason */
  (reason, promise) => {
    log("META", "A unhandled rejection occurred.", reason);

    if (isRecoverableRuntimeError(reason)) {
      log("META", "Ignoring recoverable runtime rejection and keeping the process alive.");
      return;
    }

    try {
      discordClient.destroy();
    } catch {}

    try {
      fluxerClient.destroy();
    } catch {}

    process.exit(1);
  }
);

/** @type {string[]} */
const discordVoiceTokens = Array.isArray(Config.DiscordVoiceTokens) ? Config.DiscordVoiceTokens.filter(Boolean) : [];
/** @type {import("discord.js").Client[]} */
export const discordVoiceClients = [];
for (const [i, token] of discordVoiceTokens.entries()) {
  const voiceClient = new DiscordClient({
    rest: { timeout: 30_000 },
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  voiceClient.on(DiscordEvents.ClientReady, () => {
    log("DISCORD", `Voice client ${i + 1}/${discordVoiceTokens.length} ready as ${voiceClient.user?.tag}`);
  });
  voiceClient.login(token).catch(e => {
    log("DISCORD", `Voice client ${i + 1} failed to login`, e);
  });
  discordVoiceClients.push(voiceClient);
}

if (Config.VoiceBridgingEnabled) {
  const voiceHandler = await import("./utils/VoiceHandler.js");
  const { setupVoiceHandling } = voiceHandler;
  startVoiceRecovery = voiceHandler.startVoiceRecovery;
  await setupVoiceHandling(discordClient, fluxerClient, discordVoiceClients);
}

setupReactionHandling(discordClient, fluxerClient);

setupHealthcheck(discordClient, fluxerClient);

setupDiscordCommands(discordClient, fluxerClient);

discordClient.login(Config.DiscordBotToken);
fluxerClient.login(Config.FluxerBotToken);

function checkIfFluxerConnected() {
  if (!fluxerClient.isReady()) {
    log("META", "Fluxer didn't connect after 10 seconds, restarting...");
    process.exit(1);
  }
}

async function loadNontrinsic(maxLen = 128) {
  try {
    log("DEBUG", "Trying to fetch nonsense from endpoint /api/v1/nonsense/random, hostname nontrinsic.linerly.xyz");
    const req = await fetch("https://nontrinsic.linerly.xyz/api/v1/nonsense/random", {
      headers: {
        "User-Agent": buildExtHttpUserAgent(),
      },
    });
    if (!req.ok) {
      log("DEBUG", `Fetch failed (code ${req.status}), skipping MOTD rotation`);
      return undefined;
    }
    const json = await req.json();
    /** @type {string} */
    // @ts-expect-error
    const nonsense = json.nonsense;
    if (nonsense.length > maxLen || /\$.+\$/.test(nonsense) || /\$\{.+\\}/.test(nonsense) || /\:.+\:/.test(nonsense)) {
      return await loadNontrinsic(maxLen);
    }
    return nonsense;
  } catch {
    log("DEBUG", `Fetch failed (probably the fetch function threw), skipping MOTD rotation`);
  }
}

async function motdLoop() {
  /**
   * @type {({ text: string, emoji: string | { fluxer: { name: string, id: string }, discord: string }| undefined } | { nontrinsic: boolean })[]}
   */
  const motds = Config.Motds;
  const motd = motds[Math.floor(Math.random() * motds.length)];

  //@ts-ignore
  if (motd) updateBotStatus(motd);
}

/**
 * @param {({ text: string, emoji: string | { fluxer: { name: string, id: string }, discord: string }| undefined, nontrinsic: undefined } | { nontrinsic: true, text: undefined, emoji: undefined })} s
 */
async function updateBotStatus(s) {
  let emoji = undefined;
  let prefix = `${Config.BotPrefix}help | `;

  let status = s;

  if (status.emoji)
    if (status.emoji instanceof Object) {
      emoji = {
        discord: status.emoji.discord,
        fluxer: {
          emoji_id: status.emoji.fluxer.id,
          emoji_name: status.emoji.fluxer.name,
        },
      };
    } else {
      emoji = {
        discord: status.emoji,
        fluxer: {
          emoji_name: status.emoji,
        },
      };
    }

  let discordPrefix = `${emoji?.discord ? `${emoji.discord} ` : ""}${prefix}`;

  if (status.nontrinsic === true) {
    const nonsense = await loadNontrinsic(discordPrefix.length);
    if (nonsense === undefined) return;

    status = {
      text: nonsense,
      emoji: undefined,
      nontrinsic: undefined,
    };
  }

  fluxerClient.user?.setPresence({
    status: "online",
    customStatus: {
      text: `${prefix}${status.text}`,
      ...(emoji
        ? {
            emojiName: emoji.fluxer.emoji_name,
            emojiId: emoji.fluxer.emoji_id,
          }
        : {}),
    },
  });

  discordClient.user?.setActivity(`${discordPrefix}${status.text}`);
}

setInterval(() => checkIfFluxerConnected(), 10000);
