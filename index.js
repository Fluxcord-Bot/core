import { Events as FluxerEvents, ChannelType as FluxerChannelType } from "@fluxerjs/core";
import Package from "./package.json" with { type: "json" };
import {
  Client as DiscordClient,
  Events as DiscordEvents,
  GatewayIntentBits,
  Partials,
  ChannelType as DiscordChannelType,
} from "discord.js";
import Config from "./utils/ConfigHandler.js";
import { getFluxerInstanceConfig, getFluxerInstances, DiscordEnabled } from "./utils/ConfigHandler.js";
import { FluxerPinsUpdateHandler } from "./utils/FluxerHandler.js";
import { DiscordPinsUpdateHandler } from "./utils/DiscordHandler.js";
import { setPipelineCtx, pipelineCreate, pipelineEdit, pipelineDelete, pipelineBulkDelete } from "./utils/pipeline/adapters.js";
import { invalidateFluxerWebhookCache } from "./utils/Webhooks.js";
import { log } from "./utils/Logger.js";
import fs from "node:fs";
import { Op } from "sequelize";
import { BridgeEndpoint, BridgeGroup, GuildMap, MessageLink, VoiceChannelMap } from "./db/index.js";
import {
  autoBridgeDiscordThread,
  autoBridgeFluxerThread,
  cleanupMirroredRow,
  mirrorDiscordThreadUpdate,
  mirrorFluxerThreadUpdate,
  isSelfCreate,
  selfCreatedThreads,
  syncForumTags,
} from "./utils/ThreadMirror.js";
import { mirrorDiscordTopic, mirrorFluxerTopic } from "./utils/TopicMirror.js";
import { isBridgeToggleEnabled } from "./utils/BridgeToggle.js";
import { sendErrorMessage } from "./utils/SendErrorMessage.js";
import { genAuthLink, renderBox } from "./utils/GenAuthLink.js";
import { setupReactionHandling, setupFluxerReactionHandling } from "./utils/ReactionHandler.js";
import { setupHealthcheck } from "./utils/HealthCheck.js";
import { ensureLoadingEmojis } from "./utils/LoadingEmojiSetup.js";
import { runStartupSync } from "./utils/StartupSync.js";
import { registerDiscordCommands, setupDiscordCommands } from "./utils/DiscordCommands.js";
import { buildDiscordUserAgentSuffix, buildExtHttpUserAgent } from "./utils/UserAgent.js";
import { isFluxerRateLimited, noteFluxerRateLimit, withFluxerRateLimit } from "./utils/FluxerRateLimit.js";
import { randomUUID } from "node:crypto";
import getCommitHash from "./utils/GetCommitHash.js";
import {
  checkFluxerConnections,
  defaultFluxerClient,
  fluxerClients,
  getFluxerClient,
  setupFluxerClients,
} from "./utils/FluxerClients.js";

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

/**
 * @param {{ platform?: string, channelId?: string, kind?: string, instanceId?: string, groupId?: number, [k: string]: any }} where
 */
async function destroyEndpoints(where) {
  const endpoints = await BridgeEndpoint.findAll({ where, attributes: ["id"] });
  await destroyEndpointsByIds(endpoints.map(e => e.get("id")));
}

/**
 * @param {number[]} ids
 */
async function destroyEndpointsByIds(ids) {
  if (ids.length === 0) return;
  const children = await BridgeEndpoint.findAll({
    where: { parentEndpointId: { [Op.in]: ids } },
    attributes: ["id"],
  });
  const allIds = [...ids, ...children.map(c => c.get("id"))];
  await MessageLink.destroy({ where: { endpointId: { [Op.in]: allIds } } });
  await BridgeEndpoint.destroy({ where: { id: { [Op.in]: allIds } } });
}

/**
 * @param {"discord" | "fluxer"} platform
 * @param {string} guildId
 */
async function destroyEndpointsByGuild(platform, guildId) {
  await destroyEndpoints({ platform, guildId });
}

discordClient.on(DiscordEvents.GuildDelete, async guild => {
  if (!guild.available) return;

  try {
    await destroyEndpointsByGuild("discord", guild.id);
    for (const [, client] of fluxerClients) {
      await GuildMap.destroy({
        where: {
          guildId: guild.id,
          guildType: "discord",
        },
      });
      break;
    }
  } catch (e) {
    log("DB", `GuildDelete cleanup failed for guild ${guild.id}`, e);
  }
});

discordClient.on(DiscordEvents.ChannelDelete, async chnl => {
  try {
    await destroyEndpoints({ platform: "discord", channelId: chnl.id });
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
    const parentEndpoints = await BridgeEndpoint.findAll({
      where: { platform: "discord", channelId: thread.parentId, kind: "channel" },
    });
    for (const parentEndpoint of parentEndpoints) {
      const group = await BridgeGroup.findByPk(parentEndpoint.groupId);
      if (!group || group.bridgeType === "fluxer2discord") continue;
      await autoBridgeDiscordThread(thread, parentEndpoint, discordClient);
    }
  } catch (e) {
    log("FLUXER", `Failed to auto-bridge Discord thread ${thread.id}`, e);
  }
});

discordClient.on(DiscordEvents.ThreadDelete, async thread => {
  try {
    const endpoints = await BridgeEndpoint.findAll({
      where: { platform: "discord", channelId: thread.id },
    });
    for (const endpoint of endpoints) {
      if (endpoint.autoMirrored) await cleanupMirroredRow(endpoint, discordClient, "discord");
    }
    await destroyEndpoints({ platform: "discord", channelId: thread.id });
  } catch (e) {
    log("DB", `ThreadDelete cleanup failed for discord thread ${thread.id}`, e);
  }
});

discordClient.on(DiscordEvents.ThreadUpdate, async (oldThread, newThread) => {
  try {
    await mirrorDiscordThreadUpdate(oldThread, newThread, discordClient);
  } catch (e) {
    log("FLUXER", `Failed to mirror Discord thread update ${newThread.id}`, e);
  }
});

discordClient.on(DiscordEvents.ChannelUpdate, async (oldChannel, newChannel) => {
  const isForum = newChannel.type === DiscordChannelType.GuildForum || newChannel.type === DiscordChannelType.GuildMedia;
  if (!isForum) {
    try {
      await mirrorDiscordTopic(newChannel, discordClient);
    } catch (e) {
      log("FLUXER", `Failed to mirror topic for Discord channel ${newChannel.id}`, e);
    }
    return;
  }
  try {
    await syncForumTags(newChannel, "discord", discordClient);
  } catch (e) {
    log("FLUXER", `Failed to sync forum tags for Discord forum ${newChannel.id}`, e);
  }
});

discordClient.on(DiscordEvents.TypingStart, async type => {
  if (type.user.id === discordClient.user?.id) return;

  try {
    const sourceEndpoints = await BridgeEndpoint.findAll({
      where: { platform: "discord", channelId: type.channel.id },
    });
    if (!Config.TypingIndicatorEnabled || sourceEndpoints.length === 0) return;

    for (const source of sourceEndpoints) {
      const group = await BridgeGroup.findByPk(source.groupId);
      if (!group || group.bridgeType === "fluxer2discord") continue;
      const targets = await BridgeEndpoint.findAll({
        where: { groupId: source.groupId, id: { [Op.ne]: source.id } },
      });
      for (const target of targets) {
        try {
          if (target.platform === "fluxer") {
            const client = getFluxerClient(target.instanceId);
            if (!client) continue;
            if (isFluxerRateLimited(`typing:${target.channelId}`)) continue;
            const channel =
              client.channels.get(target.channelId) ??
              (await withFluxerRateLimit(() => client.channels.fetch(target.channelId), `typing:${target.channelId}`));
            await withFluxerRateLimit(() => channel.sendTyping(), `typing:${target.channelId}`);
          } else {
            if (target.channelId === type.channel.id) continue;
            const channel = await discordClient.channels.fetch(target.channelId);
            if (channel?.isSendable?.()) await channel.sendTyping();
          }
        } catch (e) {
          log("DISCORD", `Failed to relay typing indicator to ${target.platform} channel ${target.channelId}:`, e);
        }
      }
    }
  } catch (e) {
    log("DISCORD", "Failed to relay typing indicator:", e);
  }
});

discordClient.on(DiscordEvents.MessageCreate, async msg => {
  if (msg.author.id === discordClient.user?.id) return;
  try {
    await pipelineCreate(msg, { instanceId: "default" });
  } catch (e) {
    await sendErrorMessage(msg, discordClient, e);
  }
});

discordClient.on(DiscordEvents.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    await pipelineEdit(newMsg, { instanceId: "default" });
  } catch (e) {
    await sendErrorMessage(newMsg, discordClient, e);
  }
});

discordClient.on(DiscordEvents.MessageDelete, async msg => {
  try {
    await pipelineDelete(msg, { instanceId: "default" });
  } catch (e) {
    log("FLUXER", e);
  }
});

discordClient.on(DiscordEvents.MessageBulkDelete, async msgs => {
  try {
    await pipelineBulkDelete({ platform: "discord", channelId: [...msgs.values()][0]?.channelId, instanceId: "default" }, [
      ...msgs.keys(),
    ]);
  } catch (e) {
    log("FLUXER", e);
  }
});

discordClient.on(DiscordEvents.ChannelPinsUpdate, async channel => {
  try {
    await DiscordPinsUpdateHandler(channel);
  } catch (e) {
    log("FLUXER", e);
  }
});

/**
 * @param {string} instanceId
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
function wireFluxerEvents(instanceId, fluxerClient) {
  setupFluxerReactionHandling(discordClient, fluxerClient);

  fluxerClient.on(FluxerEvents.ChannelDelete, async chnl => {
    try {
      await destroyEndpoints({ platform: "fluxer", channelId: chnl.id });
      invalidateFluxerWebhookCache(chnl.id);
    } catch (e) {
      log("DB", `ChannelDelete cleanup failed for fluxer channel ${chnl.id}`, e);
    }
  });

  fluxerClient.on(FluxerEvents.WebhooksUpdate, payload => {
    invalidateFluxerWebhookCache(payload.channelId);
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
      const parentEndpoints = await BridgeEndpoint.findAll({
        where: { platform: "fluxer", channelId: thread.parentId, kind: "channel", instanceId },
      });
      for (const parentEndpoint of parentEndpoints) {
        const group = await BridgeGroup.findByPk(parentEndpoint.groupId);
        if (!group || group.bridgeType === "discord2fluxer") continue;
        await autoBridgeFluxerThread(thread, parentEndpoint, discordClient, fluxerClient);
      }
    } catch (e) {
      log("DISCORD", `Failed to auto-bridge Fluxer thread ${thread.id}`, e);
    }
  });

  fluxerClient.on(FluxerEvents.ThreadDelete, async thread => {
    try {
      const endpoints = await BridgeEndpoint.findAll({
        where: { platform: "fluxer", channelId: thread.id, instanceId },
      });
      for (const endpoint of endpoints) {
        if (endpoint.autoMirrored) await cleanupMirroredRow(endpoint, discordClient, "fluxer");
      }
      await destroyEndpoints({ platform: "fluxer", channelId: thread.id });
    } catch (e) {
      log("DB", `ThreadDelete cleanup failed for fluxer thread ${thread.id}`, e);
    }
  });

  fluxerClient.on(FluxerEvents.ThreadUpdate, async (oldThread, newThread) => {
    try {
      await mirrorFluxerThreadUpdate(oldThread, newThread, discordClient, fluxerClient);
    } catch (e) {
      log("DISCORD", `Failed to mirror Fluxer thread update ${newThread.id}`, e);
    }
  });

  fluxerClient.on(FluxerEvents.ChannelUpdate, async (oldChannel, newChannel) => {
    const isForum = typeof newChannel.isForum === "function" && newChannel.isForum();
    const isMedia = typeof newChannel.isMedia === "function" && newChannel.isMedia();
    if (!isForum && !isMedia) {
      try {
        await mirrorFluxerTopic(newChannel, discordClient, fluxerClient);
      } catch (e) {
        log("DISCORD", `Failed to mirror topic for Fluxer channel ${newChannel.id}`, e);
      }
      return;
    }
    try {
      await syncForumTags(newChannel, "fluxer", discordClient);
    } catch (e) {
      log("DISCORD", `Failed to sync forum tags for Fluxer forum ${newChannel.id}`, e);
    }
  });

  fluxerClient.on(FluxerEvents.MessageCreate, async msg => {
    try {
      if (msg.author.id === fluxerClient.user?.id) return;
      await pipelineCreate(msg, { instanceId });
    } catch (e) {
      await sendErrorMessage(msg, discordClient, e, { instanceId });
    }
  });

  fluxerClient.on(FluxerEvents.MessageUpdate, async (oldMsg, newMsg) => {
    try {
      await pipelineEdit(oldMsg, { instanceId });
    } catch (e) {
      if (newMsg.partial) {
        log("FLUXER", "An error occurred", e);
      } else {
        await sendErrorMessage(newMsg, discordClient, e);
      }
    }
  });

  fluxerClient.on(FluxerEvents.MessageDelete, async msg => {
    try {
      await pipelineDelete(msg, { instanceId });
    } catch (e) {
      log("DISCORD", e);
    }
  });

  fluxerClient.on(FluxerEvents.MessageDeleteBulk, async msgs => {
    try {
      await pipelineBulkDelete({ platform: "fluxer", channelId: msgs.channelId, instanceId }, msgs.ids);
    } catch (e) {
      log("DISCORD", e);
    }
  });

  fluxerClient.on(FluxerEvents.ChannelPinsUpdate, async chnl => {
    try {
      await FluxerPinsUpdateHandler(chnl, discordClient, fluxerClient, { instanceId });
    } catch (e) {
      log("DISCORD", e);
    }
  });

  fluxerClient.on(FluxerEvents.TypingStart, async type => {
    if (type.userId === fluxerClient.user?.id) return;

    try {
      const sourceEndpoints = await BridgeEndpoint.findAll({
        where: { platform: "fluxer", channelId: type.channelId, instanceId },
      });
      if (!Config.TypingIndicatorEnabled || sourceEndpoints.length === 0) return;

      for (const source of sourceEndpoints) {
        const group = await BridgeGroup.findByPk(source.groupId);
        if (!group || group.bridgeType === "discord2fluxer") continue;
        const targets = await BridgeEndpoint.findAll({
          where: { groupId: source.groupId, id: { [Op.ne]: source.id } },
        });
        for (const target of targets) {
          try {
            if (target.platform === "discord") {
              const channel = await discordClient.channels.fetch(target.channelId);
              if (channel && channel.isSendable()) await channel.sendTyping();
            } else {
              if (target.channelId === type.channelId) continue;
              const client = getFluxerClient(target.instanceId);
              if (!client) continue;
              const channel =
                client.channels.get(target.channelId) ?? (await client.channels.fetch(target.channelId).catch(() => null));
              if (channel?.isTextBased?.()) await channel.sendTyping();
            }
          } catch (e) {
            log("FLUXER", `Failed to relay typing indicator to ${target.platform} channel ${target.channelId}:`, e);
          }
        }
      }
    } catch (e) {
      log("FLUXER", "Failed to relay typing indicator:", e);
    }
  });

  fluxerClient.on(FluxerEvents.Ready, async () => {
    log("FLUXER", `[${instanceId}] ${fluxerClient.user?.username}#${fluxerClient.user?.discriminator} is ready!`);

    const mapsCount = await BridgeEndpoint.count();
    fluxerClient.user?.setPresence({
      status: "online",
      customStatus: {
        text: `${Config.BotPrefix}help | bridging ${mapsCount} channel${mapsCount > 1 ? "s" : ""}`,
      },
    });

    fluxerReadyPerInstance.set(instanceId, true);
    fluxerEverReadyPerInstance.set(instanceId, true);
    if (discordReady && allFluxerInstancesReadyAtLeastOnce()) runOnBothReadyOnce();
  });
}

let discordReady = !DiscordEnabled;
let bothReadyRan = false;

function runOnBothReadyOnce() {
  if (bothReadyRan) return;
  bothReadyRan = true;
  onBothReady().catch(e => log("META", "onBothReady failed", e));
}

const fluxerReadyPerInstance = new Map();

const fluxerEverReadyPerInstance = new Map();

let startVoiceRecovery = null;

/**
 * @param {any} error
 * @returns {boolean}
 */
function isRecoverableRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (!message) return false;

  if (message.includes("Used disallowed intents")) {
    renderBox([
      "Message Content Intent is not enabled!",
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

/**
 * @returns {boolean}
 */
function allFluxerInstancesReadyAtLeastOnce() {
  return [...fluxerClients.keys()].every(id => fluxerEverReadyPerInstance.get(id));
}

/**
 * @returns {Promise<void>}
 */
/**
 * @param {string[]} names
 * @returns {Promise<Buffer[]>}
 */
async function fetchInternalAssets(names) {
  const buffers = [];
  for (const name of names) {
    const res = await fetch(Config.InternalAssetsPrefixUrl + "/" + name, {
      headers: {
        "User-Agent": buildExtHttpUserAgent(),
      },
    });
    if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }
  return buffers;
}

/**
 * @param {import("@fluxerjs/core").Client} client
 * @param {string} tempGuildId
 * @param {Buffer} replyL
 * @param {Buffer} replyR
 */
async function createFluxerReplyEmojis(client, tempGuildId, replyL, replyR) {
  const fluxerGuild = await client.guilds.fetch(tempGuildId);
  try {
    await fluxerGuild?.createEmojisBulk([
      {
        image: replyL.toString("base64"),
        name: "reply_l",
      },
      {
        image: replyR.toString("base64"),
        name: "reply_r",
      },
    ]);
  } catch {}

  const replyLToken = await client.resolveEmoji(":reply_l:", tempGuildId);
  const replyRToken = await client.resolveEmoji(":reply_r:", tempGuildId);
  if (!replyLToken || !replyRToken) {
    throw new Error(`Could not create reply emojis in Fluxer temp guild ${tempGuildId}`);
  }
  return { replyL: replyLToken, replyR: replyRToken };
}

/**
 * @param {Buffer} replyL
 * @param {Buffer} replyR
 */
async function createDiscordReplyEmojis(replyL, replyR) {
  let replyLId;
  let replyRId;
  try {
    replyLId = (await discordClient.application?.emojis.create({ attachment: replyL, name: "reply_l" }))?.id;
  } catch {}
  try {
    replyRId = (await discordClient.application?.emojis.create({ attachment: replyR, name: "reply_r" }))?.id;
  } catch {}
  if (!replyLId || !replyRId) {
    const existing = await discordClient.application?.emojis.fetch();
    replyLId ??= existing?.find(e => e.name === "reply_l")?.id;
    replyRId ??= existing?.find(e => e.name === "reply_r")?.id;
  }
  if (!replyLId || !replyRId) {
    throw new Error("Could not create reply emojis on Discord");
  }
  return { replyL: replyLId, replyR: replyRId };
}

/**
 * @returns {Promise<void>}
 */
async function onBothReady() {
  startVoiceRecovery?.();
  const jsonPath = Config.DataFolderPath + "/fluxcord.json";
  const isFirstTime = !fs.existsSync(jsonPath);
  if (isFirstTime) {
    log("META", "Welcome to Fluxcord! Doing first-time setup...");
  }

  try {
    let t;
    if (isFirstTime) {
      t = {
        autoGenerated: "This file is automatically generated by Fluxcord. Please do not touch it!",
        fluxerReplyEmoji: {},
      };
    } else {
      t = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      if (!t.fluxerReplyEmoji || typeof t.fluxerReplyEmoji !== "object") {
        t.fluxerReplyEmoji = {};
      }
      if (!t.fluxerReplyEmoji.default && t.fluxerReplyEmoji.replyL) {
        t.fluxerReplyEmoji.default = { replyL: t.fluxerReplyEmoji.replyL, replyR: t.fluxerReplyEmoji.replyR };
        delete t.fluxerReplyEmoji.replyL;
        delete t.fluxerReplyEmoji.replyR;
      }
    }

    const [replyL, replyR] = await fetchInternalAssets(["reply-l.webp", "reply-r.webp"]);

    let changed = isFirstTime;
    for (const [instanceId, client] of fluxerClients) {
      const entry = t.fluxerReplyEmoji[instanceId];
      if (entry?.replyL && entry?.replyR) continue;
      const instCfg = getFluxerInstanceConfig(instanceId);
      t.fluxerReplyEmoji[instanceId] = await createFluxerReplyEmojis(client, instCfg.FluxerTempEmojiGuildId, replyL, replyR);
      log("META", `Created reply emojis for Fluxer instance ${instanceId}`);
      changed = true;
    }

    if (DiscordEnabled && !(t.discordReplyEmoji?.replyL && t.discordReplyEmoji.replyR)) {
      t.discordReplyEmoji = await createDiscordReplyEmojis(replyL, replyR);
      log("META", "Created reply emojis for Discord");
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(jsonPath, JSON.stringify(t));
    }
    if (isFirstTime) {
      log("META", "First time setup done! Enjoy using the bot!");
    }
  } catch (e) {
    log("META", "For jb (or Fluxcord team), error is:", e);
    renderBox([
      isFirstTime ? "First time setup failed!" : "fluxcord.json setup failed!",
      "",
      "To avoid footguns because of this, Fluxcord will shut down itself.",
      "You can start it later with `docker compose up -d`.",
      "",
      "Please join jb's unlabeled capacitor for support:",
      "https://fluxer.gg/jbcrn",
    ]);
    process.exit(0);
  }

  try {
    if (Config.EnableAnalytics) {
      const jsonPath = Config.DataFolderPath + "/fluxcord.json";
      const current = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

      if (!current.gatoInstanceId) {
        current.gatoInstanceId = randomUUID();
        fs.writeFileSync(jsonPath, JSON.stringify(current));
      }

      const sendToGato = async () => {
        const channels = await BridgeEndpoint.count();
        const messages = await MessageLink.count();
        const discordGuildCount = discordClient.guilds.cache.size;
        const discordUserCount = discordClient.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
        let fluxerGuildCount = 0;
        let fluxerUserCount = 0;
        for (const [, client] of fluxerClients) {
          fluxerGuildCount += client.guilds.size;
          fluxerUserCount += client.guilds.reduce((acc, guild) => acc + (guild.memberCount ?? guild.members.size), 0);
        }

        await fetch("https://gato.fluxcord.jbcrn.dev/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instance_id: current.gatoInstanceId,
            int_items: {
              bridgedChannelCount: channels,
              bridgedMessageCount: messages,
              discordGuildCount,
              fluxerGuildCount,
              discordUserCount,
              fluxerUserCount,
            },
            str_items: {
              version: `${Package.version}+${getCommitHash()}`,
              fluxerInstanceType:
                defaultFluxerClient?.rest?.baseUrl.includes("fluxer.app") ||
                defaultFluxerClient?.rest?.baseUrl.includes("fluxer.com")
                  ? "fluxer.com"
                  : "self-hosted",
            },
          }),
        });
      };

      sendToGato();
      setInterval(async () => await sendToGato(), 60 * 60 * 1000);
    }
  } catch (e) {}

  try {
    await ensureLoadingEmojis(discordClient, defaultFluxerClient);
  } catch (e) {
    log("META", "Loading emoji setup failed, early bridge placeholders will use fallback markers.", e);
  }

  if (Config.Motds && ((Config.Motds.length > 0 && Config.Motds.every(x => !!x)) || Config.Motds === "nontrinsic")) {
    setInterval(
      async () => {
        await motdLoop();
      },
      10 * 60 * 1000
    );
    await motdLoop();
  }

  const mapsCount = await BridgeEndpoint.count();
  void mapsCount;

  const inviteLines = ["To invite Fluxcord to your server, here's the invite links:", ""];
  if (DiscordEnabled) {
    inviteLines.push("Discord:", await genAuthLink(Config.DiscordClientId), "");
  }
  inviteLines.push("Fluxer:", await genAuthLink(defaultFluxerClient?.user?.id, true, "default"), "");
  for (const [instanceId, client] of fluxerClients) {
    if (instanceId === "default") continue;
    inviteLines.push(`Fluxer (${instanceId}):`, await genAuthLink(client?.user?.id, true, instanceId), "");
  }
  renderBox(inviteLines);

  runStartupSync(discordClient).catch(e => log("META", "Startup sync failed", e));
}

discordClient.on(DiscordEvents.ClientReady, async () => {
  log("DISCORD", `${discordClient.user?.tag} is ready!`);

  try {
    await registerDiscordCommands(discordClient, defaultFluxerClient);
  } catch (e) {
    log("DISCORD", "Failed to register application commands:", e);
  }

  const mapsCount = await BridgeEndpoint.count();
  discordClient.user?.setActivity(`${Config.BotPrefix}help | bridging ${mapsCount} channel${mapsCount > 1 ? "s" : ""}`);

  discordReady = true;
  if (allFluxerInstancesReadyAtLeastOnce()) runOnBothReadyOnce();
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

  for (const [, client] of fluxerClients) {
    try {
      client.destroy();
    } catch {}
  }

  process.exit(1);
});
process.on(
  "unhandledRejection",

  (reason, promise) => {
    log("META", "A unhandled rejection occurred.", reason);

    if (isRecoverableRuntimeError(reason)) {
      log("META", "Ignoring recoverable runtime rejection and keeping the process alive.");
      return;
    }

    try {
      discordClient.destroy();
    } catch {}

    for (const [, client] of fluxerClients) {
      try {
        client.destroy();
      } catch {}
    }

    process.exit(1);
  }
);

const discordVoiceTokens =
  DiscordEnabled && Array.isArray(Config.DiscordVoiceTokens) ? Config.DiscordVoiceTokens.filter(Boolean) : [];

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

await setupFluxerClients(wireFluxerEvents, () => "");
setPipelineCtx({ discordClient, defaultFluxerClient });

const missingTempGuildInstances = getFluxerInstances().filter(inst => !inst.FluxerTempEmojiGuildId);
if (missingTempGuildInstances.length > 0) {
  renderBox([
    "Missing FluxerTempEmojiGuildId for Fluxer instance(s): " + missingTempGuildInstances.map(i => i.id).join(", "),
    "",
    "Every Fluxer instance needs its own temporary emoji store community.",
    "Set FluxerTempEmojiGuildId for each entry in your FluxerInstances config",
    "(or the root-level FluxerTempEmojiGuildId for the default instance).",
    "",
    "Please join jb's unlabeled capacitor for support:",
    "https://fluxer.gg/jbcrn",
  ]);
  process.exit(0);
}

if (Config.VoiceBridgingEnabled) {
  if (!DiscordEnabled) {
    log("META", "Voice bridging requires a Discord bot token, skipping voice setup.");
  } else {
    const voiceHandler = await import("./utils/VoiceHandler.js");
    const { setupVoiceHandling } = voiceHandler;
    startVoiceRecovery = voiceHandler.startVoiceRecovery;
    await setupVoiceHandling(discordClient, defaultFluxerClient, discordVoiceClients);
  }
}

setupReactionHandling(discordClient);

setupHealthcheck(discordClient);

if (DiscordEnabled) {
  setupDiscordCommands(discordClient, defaultFluxerClient);
}

async function loginDiscord() {
  if (!DiscordEnabled || discordClient.isReady()) return;
  try {
    discordClient.ws["destroyed"] = false;
    await discordClient.login(Config.DiscordBotToken);
  } catch (e) {
    log("DISCORD", "Login failed retrying in 15 seconds", e);
    setTimeout(loginDiscord, 15000);
  }
}

discordClient.on(DiscordEvents.ShardError, (error, shardId) => {
  log("DISCORD", `Shard  ${shardId} errored`, error);
  if (isRecoverableRuntimeError(error)) return;
  process.exit(1);
});

discordClient.on(DiscordEvents.ShardDisconnect, (event, shardId) => {
  log("DISCORD", `Shard ${shardId} disconnected (code ${event?.code ?? "unknown"}), reconnecting in 15 seconds`);
  setTimeout(loginDiscord, 15000);
});

loginDiscord();

setInterval(() => checkFluxerConnections(), 10000);

const motds = Config.Motds;

/**
 * @param {number} maxLen
 * @returns {Promise<string>}
 */
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
  const motds = Config.Motds;
  const motd = motds[Math.floor(Math.random() * motds.length)];
  if (motd) updateBotStatus(motd);
}

/**
 * @param {string} s
 * @returns {Promise<void>}
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

  for (const [, client] of fluxerClients) {
    client.user?.setPresence({
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
  }

  discordClient.user?.setActivity(`${discordPrefix}${status.text}`);
}
