import Config from "./ConfigHandler.js";
import { ChannelType as FluxerChannelType } from "@fluxerjs/core";
import { ChannelType as DiscordChannelType } from "discord.js";
import { BridgeEndpoint, MessageLink } from "../db/index.js";
import { Op } from "sequelize";
import { sanitizePings } from "./SanitizePings.js";
import { sendFluxerWebhook } from "./FluxerWebhookSend.js";
import { cloudUploadAttachments } from "./CloudUpload.js";
import { resolveNameIndicator, withIndicator } from "./NameIndicator.js";
import { discordEmbedToFluxer, fluxerEmbedToDiscord, isPlatformPreviewEmbed } from "./EmbedConverter.js";
import {
  isDiscordSpoilerAttachment,
  isFluxerSpoilerAttachment,
  SPOILER_ATTACHMENT_FLAG,
  toDiscordSpoilerFilename,
} from "./SpoilerAttachments.js";
import { log } from "./Logger.js";
import { canUserBridge } from "./UserOptOut.js";
import { runBackfill } from "./BackfillQueue.js";
import { withFluxerRateLimit } from "./FluxerRateLimit.js";
import { newLinkGroup } from "./Bridging.js";
import { getFluxerClient } from "./FluxerClients.js";

const MAX_POST_TAGS = 5;
const MAX_FORUM_TAGS = 20;
const PINNED_POST_FLAG = 1 << 1;

const pendingMirrors = new Map();

function claimPendingMirror(platform, threadId) {
  const key = `${platform}:${threadId}`;
  if (pendingMirrors.has(key)) return null;
  let resolve;
  const promise = new Promise(res => {
    resolve = res;
  });
  const claim = { key, promise, resolve, made: [] };
  pendingMirrors.set(key, claim);
  return claim;
}

function settlePendingMirror(claim, value) {
  claim.made.push(...(Array.isArray(value) ? value : value ? [value] : []));
  claim.resolve(value);
}

function releasePendingMirror(claim) {
  if (pendingMirrors.get(claim.key) === claim) pendingMirrors.delete(claim.key);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const MAX_POST_ATTACHMENT_SIZE = 24999900;

async function fetchStarterWithRetry(fetchFn) {
  let message = null;
  for (let attempt = 0; attempt < 4 && !message; attempt++) {
    try {
      message = await fetchFn();
    } catch {
      if (attempt < 3) await delay(400);
    }
  }
  return message;
}

async function downloadPostAttachment(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log("FLUXER", `Failed to download bridged post attachment ${url}`, e);
    return null;
  }
}

/**
 * @param {any} thread
 * @param {(message: any) => Promise<void>} bridgeMessage
 * @param {string | null} guildId
 * @returns {Promise<void>}
 */
export async function backfillMirroredThread(thread, bridgeMessage, guildId) {
  return runBackfill(guildId, async () => {
    const messages = [];
    let before = null;
    while (messages.length < Config.MaxBackfillMessages) {
      const page = await thread.messages.fetch({
        limit: Math.min(100, Config.MaxBackfillMessages - messages.length),
        ...(before ? { before } : {}),
      });
      const batch = [...page.values()];
      if (batch.length === 0) break;
      messages.push(...batch);
      before = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }
    for (const message of messages.reverse()) {
      const existing = await MessageLink.findOne({ where: { messageId: message.id } });
      if (existing) continue;
      try {
        await bridgeMessage(message);
      } catch {}
      await delay(2000);
    }
  });
}

/**
 * @param {"discord" | "fluxer"} platform
 * @param {string} threadId
 * @returns {Promise<any[]>}
 */
export async function waitForPendingMirror(platform, threadId) {
  const claim = pendingMirrors.get(`${platform}:${threadId}`);
  if (!claim) return null;
  try {
    await claim.promise;
    return claim.made;
  } catch {
    return null;
  }
}

export const selfCreatedThreads = new Set();

const inFlightSelfCreates = new Map();

const SELF_CREATE_GRACE_MS = 3000;

function markSelfCreate(key, promise) {
  inFlightSelfCreates.set(key, promise);
  const cleanup = () =>
    setTimeout(() => {
      if (inFlightSelfCreates.get(key) === promise) inFlightSelfCreates.delete(key);
    }, SELF_CREATE_GRACE_MS);
  promise.then(cleanup, cleanup);
}

/**
 * @param {string} key
 * @param {string} threadId
 * @returns {Promise<boolean>}
 */
export async function isSelfCreate(key, threadId) {
  const pending = inFlightSelfCreates.get(key);
  if (!pending) return false;
  const id = await Promise.race([pending.catch(() => null), delay(10_000).then(() => null)]);
  return id === threadId;
}

function readTags(channel, platform) {
  const raw = channel?.availableTags ?? [];
  if (platform === "discord") {
    return raw.map(t => ({
      id: t.id,
      name: t.name,
      moderated: !!t.moderated,
      emojiId: t.emoji?.id ?? null,
      emojiName: t.emoji?.id ? null : (t.emoji?.name ?? null),
    }));
  }
  return raw.map(t => ({
    id: t.id,
    name: t.name,
    moderated: !!t.moderated,
    emojiId: t.emojiId ?? null,
    emojiName: t.emojiId ? null : (t.emojiName ?? null),
  }));
}

async function persistTagMap(endpoint, tagMap) {
  const row = await BridgeEndpoint.findByPk(endpoint.id);
  if (!row) return;
  row.set("tagMap", tagMap);
  await row.save();
}

/**
 * @param {BridgeEndpoint} anchorEndpoint
 * @param {string[]} tagIds
 * @param {BridgeEndpoint} discordParent
 * @param {BridgeEndpoint} fluxerParent
 * @returns {Promise<string[]>} fluxer tag ids
 */
export async function mapTagsToFluxer(anchorEndpoint, tagIds, discordParent, fluxerParent) {
  if (!tagIds?.length || !fluxerParent) return [];
  const tagMap = Array.isArray(anchorEndpoint.tagMap) ? anchorEndpoint.tagMap : [];
  const sourceTags = discordParent ? readTags(discordParent, "discord") : [];
  let changed = false;
  const ids = [];
  for (const id of tagIds.slice(0, MAX_POST_TAGS)) {
    let entry = tagMap.find(t => t.discordId === id);
    if (!entry) {
      const sourceTag = sourceTags.find(t => t.id === id);
      if (!sourceTag) continue;
      const fluxerTag = (fluxerParent.availableTags ?? []).find(t => t.name.toLowerCase() === sourceTag.name.toLowerCase());
      entry = {
        name: sourceTag.name,
        discordId: id,
        fluxerId: fluxerTag?.id ?? null,
        moderated: sourceTag.moderated,
        emojiName: sourceTag.emojiName ?? null,
      };
      tagMap.push(entry);
      changed = true;
    }
    if (entry.fluxerId) ids.push(entry.fluxerId);
  }
  if (changed) await persistTagMap(anchorEndpoint, tagMap);
  return ids;
}

/**
 * @param {BridgeEndpoint} anchorEndpoint
 * @param {string[]} tagIds
 * @param {BridgeEndpoint} fluxerParent
 * @param {BridgeEndpoint} discordParent
 * @returns {Promise<string[]>} discord tag ids
 */
export async function mapTagsToDiscord(anchorEndpoint, tagIds, fluxerParent, discordParent) {
  if (!tagIds?.length || !discordParent) return [];
  const tagMap = Array.isArray(anchorEndpoint.tagMap) ? anchorEndpoint.tagMap : [];
  const sourceTags = fluxerParent ? readTags(fluxerParent, "fluxer") : [];
  let changed = false;
  const ids = [];
  for (const id of tagIds.slice(0, MAX_POST_TAGS)) {
    let entry = tagMap.find(t => t.fluxerId === id);
    if (!entry) {
      const sourceTag = sourceTags.find(t => t.id === id);
      if (!sourceTag) continue;
      const discordTag = (discordParent.availableTags ?? []).find(t => t.name.toLowerCase() === sourceTag.name.toLowerCase());
      entry = {
        name: sourceTag.name,
        discordId: discordTag?.id ?? null,
        fluxerId: id,
        moderated: sourceTag.moderated,
        emojiName: sourceTag.emojiName ?? null,
      };
      tagMap.push(entry);
      changed = true;
    }
    if (entry.discordId) ids.push(entry.discordId);
  }
  if (changed) await persistTagMap(anchorEndpoint, tagMap);
  return ids;
}

/**
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {BridgeEndpoint} endpoint
 * @returns {Promise<string | null>}
 */
export async function fluxerThreadIdFor(fluxerClient, endpoint) {
  if (!endpoint?.autoMirrored) return null;
  const siblings = await BridgeEndpoint.findAll({
    where: { groupId: endpoint.groupId, platform: "fluxer", kind: "thread", channelId: { [Op.ne]: endpoint.channelId } },
  });
  const sibling = siblings[0];
  if (!sibling) return null;
  let channel;
  try {
    channel = await fluxerClient.channels.fetch(sibling.channelId);
  } catch {
    return null;
  }
  if (typeof channel?.isThread !== "function" || !channel.isThread()) return null;
  if (channel.archived && !channel.locked) {
    try {
      await channel.setArchived(false);
    } catch (e) {
      log("FLUXER", `Failed to unarchive bridged Fluxer thread ${sibling.channelId}`, e);
    }
  }
  return sibling.channelId;
}

/**
 * @param {BridgeEndpoint} endpoint
 * @returns {Promise<string | null>}
 */
export async function fluxerWebhookChannelIdFor(endpoint) {
  if (!endpoint) return null;
  if (endpoint.kind !== "thread" || !endpoint.parentEndpointId) return endpoint.channelId;
  const parent = await BridgeEndpoint.findByPk(endpoint.parentEndpointId);
  return parent?.channelId ?? endpoint.channelId;
}
async function pairedParentEndpoints(parentEndpoint) {
  const siblings = await BridgeEndpoint.findAll({
    where: { groupId: parentEndpoint.groupId, kind: "channel", platform: { [Op.ne]: parentEndpoint.platform } },
  });
  return siblings.filter(s => s.channelId !== parentEndpoint.channelId);
}

function createThreadEndpointPair(parents) {
  const discordParent = parents.find(p => p.platform === "discord") ?? parents[0];
  const group = discordParent ? discordParent.groupId : parents[0].groupId;
  const guildIdFor = platform => parents.find(p => p.platform === platform)?.guildId ?? "";
  return { discordParent, group, guildIdFor };
}

/**
 * @param {any} thread
 * @param {BridgeEndpoint[]} parentEndpoints
 * @param {import("discord.js").Client} discordClient
 * @returns {Promise<BridgeEndpoint[]>}
 */
export async function autoBridgeDiscordThread(thread, parentEndpoints, discordClient) {
  const claim = claimPendingMirror("discord", thread.id);
  if (!claim) {
    log("DEBUG", `autoBridgeDiscordThread skip id=${thread.id} reason=pendingMirror`);
    return waitForPendingMirror("discord", thread.id);
  }

  
  const made = [];

  for (const parentEndpoint of parentEndpoints) {
    try {
      const [existing] = await BridgeEndpoint.findAll({ where: { platform: "discord", channelId: thread.id, groupId: parentEndpoint.groupId }, limit: 1 });
      if (existing) continue;

      const fluxerParents = await pairedParentEndpoints(parentEndpoint);

      for (const fluxerParentEndpoint of fluxerParents) {
        const fluxerClient = getFluxerClient(fluxerParentEndpoint.instanceId);
        if (!fluxerClient) continue;
        const result = await mirrorDiscordThreadToFluxer(
          thread,
          parentEndpoint,
          fluxerParentEndpoint,
          discordClient,
          fluxerClient,
          claim
        );
        if (result) made.push(...result);
        else continue;
      }
    } catch (e) {
      log("FLUXER", `Failed to auto-bridge Discord thread ${thread.id} to group ${parentEndpoint.groupId}`, e);
    }
  }

  settlePendingMirror(claim, made);
  releasePendingMirror(claim);
  return made;
}

async function mirrorDiscordThreadToFluxer(thread, parentEndpoint, fluxerParentEndpoint, discordClient, fluxerClient, claim) {
  const made = [];
  const fluxerParent = await fluxerClient.channels.fetch(fluxerParentEndpoint.channelId);
  if (!fluxerParent) return made;

  let fluxerThreadId = null;
  let starterMessageId = null;
  let attachedToStarter = false;
  let headInlined = false;
  let headAuthorId = "";

  if (typeof fluxerParent.isForum === "function" && (fluxerParent.isForum() || fluxerParent.isMedia())) {
    const headMessage = await fetchStarterWithRetry(() =>
      discordClient.channels.fetch(thread.id).then(c => c.messages.fetch(thread.id))
    );
    let starterLink = await MessageLink.findOne({
      where: { messageId: thread.id, endpointId: parentEndpoint.id },
    });
    if (!starterLink && headMessage?.webhookId === parentEndpoint.webhookId) {
      for (let i = 0; i < 12 && !starterLink; i++) {
        await delay(250);
        starterLink = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: parentEndpoint.id } });
      }
    }
    if (starterLink) {
      const fluxerStarter = await MessageLink.findOne({
        where: { linkGroup: starterLink.linkGroup, endpointId: fluxerParentEndpoint.id },
      });
      fluxerThreadId = fluxerStarter?.messageId ?? null;
      attachedToStarter = Boolean(fluxerThreadId);
      if (fluxerThreadId) log("DEBUG", `autoBridgeDiscordThread attached to Fluxer post ${fluxerThreadId}`);
    }
    if (!attachedToStarter) {
      let discordParentChannel = null;
      try {
        discordParentChannel = await discordClient.channels.fetch(parentEndpoint.channelId);
      } catch {}
      const appliedTags = await mapTagsToFluxer(parentEndpoint, thread.appliedTags ?? [], discordParentChannel, fluxerParent);
      const moderatedTags = (fluxerParent.availableTags ?? [])
        .filter(t => appliedTags.includes(t.id) && t.moderated)
        .map(t => t.id);
      const webhookTags = appliedTags.filter(id => !moderatedTags.includes(id));
      let headContent = "";
      let headUsername;
      let headAvatarUrl;
      let headEmbeds = [];
      let headFiles = [];
      if (headMessage) {
        headAuthorId = headMessage.author?.id ?? "";
        if (headAuthorId && !(await canUserBridge("discord", headAuthorId, parentEndpoint.guildId))) {
          headContent = "*Thread creator opted-out*";
          headInlined = true;
          headUsername = fluxerClient.user?.username ?? "Fluxcord";
          headAvatarUrl = fluxerClient.user?.avatarURL?.() ?? undefined;
          headAuthorId = fluxerClient.user?.id ?? headAuthorId;
        } else {
          headContent = headMessage.content ? sanitizePings(headMessage.content) : "";
          headEmbeds = await Promise.all(
            (headMessage.embeds ?? [])
              .filter(x => !isPlatformPreviewEmbed(x, headMessage.content ?? ""))
              .map(async x => await discordEmbedToFluxer(x, fluxerClient))
          );
          const overSized = [];
          for (const a of headMessage.attachments?.values() ?? []) {
            if (a.size >= MAX_POST_ATTACHMENT_SIZE) {
              overSized.push(`[${a.name}](<${a.url ?? a.proxyURL}>)`);
              continue;
            }
            headFiles.push({
              name: a.name,
              url: a.url ?? a.proxyURL,
              flags: isDiscordSpoilerAttachment(a) ? SPOILER_ATTACHMENT_FLAG : undefined,
              description: a.description,
            });
          }
          if (overSized.length > 0) {
            headContent += (headContent ? "\n" : "") + `-# has attachments over 25mb: ${overSized.join(" ")}`;
          }
          headInlined = Boolean(headContent || headFiles.length > 0 || headEmbeds.length > 0);
          if (headMessage.author) {
            let guildUser;
            try {
              guildUser = await thread.guild?.members.fetch(headMessage.author.id);
            } catch {}
            headUsername = withIndicator(
              guildUser?.displayName ?? headMessage.author.displayName ?? "Fluxcord",
              "discord",
              await resolveNameIndicator(fluxerParentEndpoint.guildId, parentEndpoint.guildId)
            );
            headAvatarUrl = guildUser?.avatarURL() ?? headMessage.author.avatarURL() ?? undefined;
          }
        }
      }
      let resolveSelfCreate;
      markSelfCreate(
        `fluxer:${fluxerParentEndpoint.channelId}`,
        new Promise(r => {
          resolveSelfCreate = r;
        })
      );
      const headGone = !headContent && headFiles.length === 0 && headEmbeds.length === 0;
      if (headGone) headContent = "-# Deleted message";
      const res = await sendFluxerWebhook(fluxerParentEndpoint.webhookId, fluxerParentEndpoint.webhookToken, fluxerClient, {
        content: headContent,
        ...(headGone ? { username: "Deleted message" } : headUsername ? { username: headUsername } : {}),
        ...(headAvatarUrl && !headGone ? { avatar_url: headAvatarUrl } : {}),
        ...(headInlined && headEmbeds.length > 0 ? { embeds: headEmbeds } : {}),
        ...(headInlined && headFiles.length > 0 ? { files: headFiles } : {}),
        thread_name: thread.name.slice(0, 100),
        allowed_mentions: { parse: [] },
        ...(webhookTags.length > 0 ? { applied_tags: webhookTags } : {}),
      });
      fluxerThreadId = res?.channel_id ?? null;
      starterMessageId = res?.id ?? null;
      if (headGone && starterMessageId) {
        try {
          await withFluxerRateLimit(
            () =>
              fluxerClient.rest.delete(
                `/webhooks/${fluxerParentEndpoint.webhookId}/${fluxerParentEndpoint.webhookToken}/messages/${starterMessageId}?thread_id=${fluxerThreadId}`,
                { auth: false }
              ),
            `webhook:${fluxerParentEndpoint.webhookId}`
          );
        } catch (e) {
          log("FLUXER", `Failed to remove the deleted head placeholder of mirrored post ${fluxerThreadId}`, e);
        }
        starterMessageId = null;
      }
      resolveSelfCreate(fluxerThreadId);
      if (moderatedTags.length > 0 && fluxerThreadId) {
        try {
          const post = await fluxerClient.channels.fetch(fluxerThreadId);
          await post.edit({ appliedTags });
        } catch (e) {
          log("FLUXER", `Failed to apply moderated tags on mirrored post ${fluxerThreadId}`, e);
        }
      }
    }
  } else {
    const starterLink = await MessageLink.findOne({
      where: { messageId: thread.id, endpointId: parentEndpoint.id },
    });
    if (starterLink) {
      const fluxerStarter = await MessageLink.findOne({
        where: { linkGroup: starterLink.linkGroup, endpointId: fluxerParentEndpoint.id },
      });
      if (fluxerStarter) {
        try {
          const starterMessage = await fluxerParent.messages.fetch(fluxerStarter.messageId);
          selfCreatedThreads.add("fluxer:" + fluxerStarter.messageId);
          const attached = await starterMessage.startThread({ name: thread.name.slice(0, 100) });
          fluxerThreadId = attached.id;
          attachedToStarter = true;
          log("DEBUG", `autoBridgeDiscordThread attached to Fluxer message ${fluxerStarter.messageId}`);
        } catch (e) {
          if (e?.code === "THREAD_ALREADY_CREATED_FOR_MESSAGE") {
            log("DEBUG", `autoBridgeDiscordThread skip id=${thread.id} reason=discordThreadAlreadyAttached`);
            return made;
          }
          log(
            "FLUXER",
            `Couldn't attach mirrored thread to Fluxer message ${fluxerStarter.messageId}, creating a standalone thread`,
            e
          );
        }
      }
    }
    if (!fluxerThreadId) {
      let resolveSelfCreate;
      markSelfCreate(
        `fluxer:${fluxerParentEndpoint.channelId}`,
        new Promise(r => {
          resolveSelfCreate = r;
        })
      );
      const created = await fluxerParent.threads.create({
        name: thread.name.slice(0, 100),
        type: thread.type === 10 ? FluxerChannelType.AnnouncementThread : FluxerChannelType.PublicThread,
      });
      resolveSelfCreate(created.id);
      fluxerThreadId = created.id;
    }
  }

  selfCreatedThreads.add("fluxer:" + fluxerThreadId);
  try {
    const rows = await BridgeGroupSafeCreate({
      discordParent: parentEndpoint,
      fluxerParent: fluxerParentEndpoint,
      discordThreadId: thread.id,
      fluxerThreadId,
    });
    made.push(...rows);
    log(
      "DEBUG",
      `autoBridgeDiscordThread mirrored discord=${thread.id} fluxer=${fluxerThreadId} group=${parentEndpoint.groupId}`
    );

    if (starterMessageId && headInlined && rows.length) {
      const linkGroup = newLinkGroup();
      try {
        await MessageLink.create({
          linkGroup,
          messageId: thread.id,
          endpointId: row.id,
          authorId: headAuthorId,
        });
        await MessageLink.create({
          linkGroup,
          messageId: starterMessageId,
          endpointId: (
          await BridgeEndpoint.findOne({
            where: { groupId: parentEndpoint.groupId, platform: "fluxer", kind: "thread", channelId: fluxerThreadId },
          })
        )?.id,
          authorId: headAuthorId,
        });
      } catch (e) {
        log("DB", "Failed to map bridged thread starter message", e);
      }
    }
  } finally {
    selfCreatedThreads.delete("fluxer:" + fluxerThreadId);
  }

  return made;
}

async function BridgeGroupSafeCreate({ discordParent, fluxerParent, discordThreadId, fluxerThreadId }) {
  const [discordThreadEndpoint] = await BridgeEndpoint.findAll({
    where: { groupId: discordParent.groupId, platform: "discord", kind: "thread", channelId: discordThreadId },
    limit: 1,
  });
  if (discordThreadEndpoint) return [discordThreadEndpoint];

  const row = await BridgeEndpoint.create({
    groupId: discordParent.groupId,
    platform: "discord",
    instanceId: "default",
    channelId: discordThreadId,
    guildId: discordParent.guildId,
    webhookId: discordParent.webhookId,
    webhookToken: discordParent.webhookToken,
    kind: "thread",
    autoMirrored: true,
    parentEndpointId: discordParent.id,
  });
  const fluxerRow = await BridgeEndpoint.create({
    groupId: discordParent.groupId,
    platform: "fluxer",
    instanceId: fluxerParent.instanceId,
    channelId: fluxerThreadId,
    guildId: fluxerParent.guildId,
    webhookId: fluxerParent.webhookId,
    webhookToken: fluxerParent.webhookToken,
    kind: "thread",
    autoMirrored: true,
    parentEndpointId: fluxerParent.id,
  });
  return [row, fluxerRow];
}

/**
 * @param {any} thread
 * @param {BridgeEndpoint[]} parentEndpoints
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @returns {Promise<BridgeEndpoint[]>}
 */
export async function autoBridgeFluxerThread(thread, parentEndpoints, discordClient, fluxerClient) {
  const claim = claimPendingMirror("fluxer", thread.id);
  if (!claim) {
    log("DEBUG", `autoBridgeFluxerThread skip id=${thread.id} reason=pendingMirror`);
    return waitForPendingMirror("fluxer", thread.id);
  }

  
  const made = [];

  for (const parentEndpoint of parentEndpoints) {
    try {
      const [existing] = await BridgeEndpoint.findAll({
        where: { platform: "fluxer", channelId: thread.id, groupId: parentEndpoint.groupId },
        limit: 1,
      });
      if (existing) continue;

      const discordParents = await pairedParentEndpoints(parentEndpoint);

      for (const discordParentEndpoint of discordParents) {
        const result = await mirrorFluxerThreadToDiscord(
          thread,
          parentEndpoint,
          discordParentEndpoint,
          discordClient,
          fluxerClient,
          claim
        );
        if (result) made.push(...result);
      }
    } catch (e) {
      log("DISCORD", `Failed to auto-bridge Fluxer thread ${thread.id} to group ${parentEndpoint.groupId}`, e);
    }
  }

  settlePendingMirror(claim, made);
  releasePendingMirror(claim);
  return made;
}

async function mirrorFluxerThreadToDiscord(thread, parentEndpoint, discordParentEndpoint, discordClient, fluxerClient, claim) {
  const made = [];
  const discordParent = await discordClient.channels.fetch(discordParentEndpoint.channelId);
  if (!discordParent) return made;

  const isForumParent =
    discordParent.type === DiscordChannelType.GuildForum || discordParent.type === DiscordChannelType.GuildMedia;

  let fluxerSourceParent = null;
  try {
    fluxerSourceParent = await fluxerClient.channels.fetch(parentEndpoint.channelId);
  } catch {}

  const instanceIdFor = parentEndpoint.instanceId ?? "default";

  let discordThreadId;
  let attachedToStarter = false;
  let headInlined = false;
  let headAuthorId = "";

  if (!isForumParent) {
    const starterLink = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: parentEndpoint.id } });
    if (starterLink) {
      const discordStarterLink = await MessageLink.findOne({
        where: { linkGroup: starterLink.linkGroup, endpointId: discordParentEndpoint.id },
      });
      if (discordStarterLink) {
        try {
          const starterMessage = await discordParent.messages.fetch(discordStarterLink.messageId);
          selfCreatedThreads.add("discord:" + discordStarterLink.messageId);
          if (starterMessage.thread) {
            discordThreadId = starterMessage.thread.id;
          } else {
            const attached = await starterMessage.startThread({ name: thread.name.slice(0, 100) });
            discordThreadId = attached.id;
          }
          attachedToStarter = true;
        } catch (e) {
          if (e?.code === "THREAD_ALREADY_CREATED_FOR_MESSAGE") {
            log("DEBUG", `autoBridgeFluxerThread skip id=${thread.id} reason=fluxerThreadAlreadyAttached`);
            return made;
          }
          log(
            "DISCORD",
            `Couldn't attach mirrored thread to Discord message ${discordStarterLink.messageId}, creating a standalone thread`,
            e
          );
        }
      }
    }
  }

  if (!discordThreadId && isForumParent) {
    const headMessage = await fetchStarterWithRetry(() =>
      fluxerClient.channels.fetch(thread.id).then(c => c.messages.fetch(thread.id))
    );
    let starterLink = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: parentEndpoint.id } });
    if (!starterLink && headMessage?.author?.id === parentEndpoint.webhookId) {
      for (let i = 0; i < 12 && !starterLink; i++) {
        await delay(250);
        starterLink = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: parentEndpoint.id } });
      }
    }
    if (starterLink) {
      const discordStarterLink = await MessageLink.findOne({
        where: { linkGroup: starterLink.linkGroup, endpointId: discordParentEndpoint.id },
      });
      discordThreadId = discordStarterLink?.messageId ?? null;
      attachedToStarter = Boolean(discordThreadId);
      if (discordThreadId) log("DEBUG", `autoBridgeFluxerThread attached to Discord post ${discordThreadId}`);
    }
    if (!attachedToStarter) {
      let resolveSelfCreate;
      markSelfCreate(
        `discord:${discordParentEndpoint.channelId}`,
        new Promise(r => {
          resolveSelfCreate = r;
        })
      );
      const appliedTags = await mapTagsToDiscord(parentEndpoint, thread.appliedTags ?? [], fluxerSourceParent, discordParent);
      const moderatedTags = (discordParent.availableTags ?? [])
        .filter(t => appliedTags.includes(t.id) && t.moderated)
        .map(t => t.id);
      const webhookTags = appliedTags.filter(id => !moderatedTags.includes(id));
      let headContent = "";
      let headFiles = [];
      let headEmbeds = [];
      let headUsername;
      let headAvatarUrl;
      if (headMessage) {
        headAuthorId = headMessage.author?.id ?? "";
        if (headAuthorId && !(await canUserBridge("fluxer", headAuthorId, parentEndpoint.guildId))) {
          headContent = "*Thread creator opted-out*";
          headInlined = true;
          headUsername = discordClient.user?.displayName ?? discordClient.user?.username ?? "Fluxcord";
          headAvatarUrl = discordClient.user?.displayAvatarURL?.() ?? undefined;
          headAuthorId = discordClient.user?.id ?? headAuthorId;
        } else {
          const files = [];
          const overSized = [];
          for (const a of headMessage.attachments ?? []) {
            const data = await downloadPostAttachment(a.proxy_url ?? a.proxyUrl ?? a.url);
            if ((a.size ?? 0) >= 19999000 || !data) {
              overSized.push(`[${a.filename}](<${a.url}>)`);
              continue;
            }
            files.push({
              attachment: data,
              name: toDiscordSpoilerFilename(a.filename, isFluxerSpoilerAttachment(a)),
              description: a.description,
            });
          }
          const embeds = await fluxerEmbedToDiscord(headMessage, discordClient);
          if (headMessage.content || files.length > 0 || embeds.length > 0) {
            headContent = headMessage.content ? sanitizePings(headMessage.content) : "";
            headFiles = files;
            headEmbeds = embeds;
          }
          if (overSized.length > 0) {
            headContent += (headContent ? "\n" : "") + `-# has attachments over 20mb: ${overSized.join(" ")}`;
          }
          headInlined = Boolean(headContent || headFiles.length > 0 || headEmbeds.length > 0);
          if (headMessage.author) {
            let guildUser;
            try {
              guildUser = await (await fluxerClient.guilds.fetch(parentEndpoint.guildId)).fetchMember(headMessage.author.id);
            } catch {}
            headUsername = withIndicator(
              guildUser?.displayName ?? headMessage.author.globalName ?? headMessage.author.username,
              "fluxer",
              await resolveNameIndicator(discordParentEndpoint.guildId, parentEndpoint.guildId)
            );
            headAvatarUrl = headMessage.author.avatarURL?.() ?? undefined;
          }
        }
      }
      const headGone = !headContent && headFiles.length === 0 && headEmbeds.length === 0;
      if (headGone) headContent = "-# Deleted message";
      const webhook = await discordClient.fetchWebhook(discordParentEndpoint.webhookId, discordParentEndpoint.webhookToken);
      const created = await webhook.send({
        content: headContent,
        ...(headGone ? { username: "Deleted message" } : headUsername ? { username: headUsername } : {}),
        ...(headAvatarUrl && !headGone ? { avatarURL: headAvatarUrl } : {}),
        ...(headInlined && headFiles.length > 0
          ? { attachments: await cloudUploadAttachments(discordClient, discordParentEndpoint.channelId, headFiles) }
          : {}),
        ...(headInlined && headEmbeds.length > 0 ? { embeds: headEmbeds } : {}),
        threadName: thread.name.slice(0, 100),
        ...(webhookTags.length > 0 ? { appliedTags: webhookTags } : {}),
        allowedMentions: { parse: [] },
      });
      if (headGone && created.channelId) {
        try {
          await webhook.deleteMessage(created.channelId, created.channelId);
        } catch (e) {
          log("DISCORD", `Failed to remove the deleted head placeholder of mirrored post ${created.channelId}`, e);
        }
      }
      resolveSelfCreate(created.channelId ?? created.id);
      discordThreadId = created.channelId ?? created.id;
      if (moderatedTags.length > 0 && discordThreadId) {
        try {
          const post = await discordClient.channels.fetch(discordThreadId);
          await post.setAppliedTags(appliedTags);
        } catch (e) {
          log("DISCORD", `Failed to apply moderated tags on mirrored post ${discordThreadId}`, e);
        }
      }
    }
  } else if (!discordThreadId && discordParent.type === DiscordChannelType.GuildAnnouncement) {
    let resolveSelfCreate;
    markSelfCreate(
      "discord:" + discordParentEndpoint.channelId,
      new Promise(r => {
        resolveSelfCreate = r;
      })
    );
    try {
      const created = await discordParent.threads.create({
        name: thread.name.slice(0, 100),
        type: DiscordChannelType.AnnouncementThread,
      });
      discordThreadId = created.id;
    } finally {
      resolveSelfCreate(discordThreadId ?? null);
    }
  } else if (!discordThreadId) {
    let resolveSelfCreate;
    markSelfCreate(
      "discord:" + discordParentEndpoint.channelId,
      new Promise(r => {
        resolveSelfCreate = r;
      })
    );
    try {
      const created = await discordParent.threads.create({
        name: thread.name.slice(0, 100),
        type: DiscordChannelType.PublicThread,
        autoArchiveDuration: 1440,
      });
      discordThreadId = created.id;
    } finally {
      resolveSelfCreate(discordThreadId ?? null);
    }
  }

  selfCreatedThreads.add("discord:" + discordThreadId);
  try {
    const [fluxerThreadEndpoint] = await BridgeEndpoint.findAll({
      where: { groupId: parentEndpoint.groupId, platform: "fluxer", kind: "thread", channelId: thread.id },
      limit: 1,
    });
    let row = fluxerThreadEndpoint;
    if (!row) {
      row = await BridgeEndpoint.create({
        groupId: parentEndpoint.groupId,
        platform: "fluxer",
        instanceId: instanceIdFor,
        channelId: thread.id,
        guildId: parentEndpoint.guildId,
        webhookId: parentEndpoint.webhookId,
        webhookToken: parentEndpoint.webhookToken,
        kind: "thread",
        autoMirrored: true,
        parentEndpointId: parentEndpoint.id,
      });
      await BridgeEndpoint.create({
        groupId: parentEndpoint.groupId,
        platform: "discord",
        instanceId: "default",
        channelId: discordThreadId,
        guildId: discordParentEndpoint.guildId,
        webhookId: discordParentEndpoint.webhookId,
        webhookToken: discordParentEndpoint.webhookToken,
        kind: "thread",
        autoMirrored: true,
        parentEndpointId: discordParentEndpoint.id,
      });
    }
    made.push(row);
    log("DEBUG", `autoBridgeFluxerThread mirrored discord=${discordThreadId} fluxer=${thread.id} endpointId=${row?.id}`);

    if (!attachedToStarter && row) {
      const fluxerRow = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: row.id } }).catch(() => null);
      if (!fluxerRow) {
        let discordStarterId = null;
        if (headInlined) {
          discordStarterId = discordThreadId;
        } else if (!isForumParent) {
          try {
            const fetched = await discordClient.channels.fetch(discordThreadId);
            const messages = await fetched.messages.fetch({ limit: 1 });
            discordStarterId = messages.first()?.id ?? null;
          } catch {}
        }
        if (discordStarterId) {
          try {
            const linkGroup = newLinkGroup();
            const discordThreadEndpoint = await BridgeEndpoint.findOne({
              where: { groupId: row.groupId, platform: "discord", kind: "thread", channelId: discordThreadId },
            });
            await MessageLink.create({ linkGroup, messageId: discordStarterId, endpointId: discordThreadEndpoint.id, authorId: headAuthorId });
            await MessageLink.create({ linkGroup, messageId: thread.id, endpointId: row.id, authorId: headAuthorId });
          } catch (e) {
            log("DB", "Failed to map bridged thread starter message", e);
          }
        }
      }
    }
  } finally {
    selfCreatedThreads.delete("discord:" + discordThreadId);
  }

  return made;
}

/**
 * @param {BridgeEndpoint} endpoint
 * @param {import("discord.js").Client} discordClient
 * @param {"discord" | "fluxer"} platform
 * @returns {Promise<void>}
 */
export async function cleanupMirroredRow(endpoint, discordClient, platform) {
  const siblings = await BridgeEndpoint.findAll({
    where: { groupId: endpoint.groupId, kind: "thread", channelId: { [Op.ne]: endpoint.channelId } },
  });
  for (const sibling of siblings) {
    if (sibling.platform === "discord") {
      try {
        const discordThread = await discordClient.channels.fetch(sibling.channelId);
        await discordThread.delete();
      } catch (e) {
        log("DISCORD", `Failed to delete mirrored Discord thread ${sibling.channelId}`, e);
      }
    } else {
      const client = getFluxerClient(sibling.instanceId);
      if (!client) continue;
      try {
        const fluxerThread = await client.channels.fetch(sibling.channelId);
        await fluxerThread.delete();
      } catch (e) {
        log("FLUXER", `Failed to delete mirrored Fluxer thread ${sibling.channelId}`, e);
      }
    }
  }
}

/**
 * @param {any} oldThread
 * @param {any} newThread
 * @param {import("discord.js").Client} discordClient
 * @returns {Promise<void>}
 */
export async function mirrorDiscordThreadUpdate(oldThread, newThread, discordClient) {
  const nameChanged = oldThread.name !== newThread.name;
  const tagsChanged = JSON.stringify(oldThread.appliedTags ?? []) !== JSON.stringify(newThread.appliedTags ?? []);
  const archivedChanged = oldThread.archived !== newThread.archived;
  const lockedChanged = oldThread.locked !== newThread.locked;
  const pinChanged =
    ((oldThread.flags?.bitfield ?? 0) & PINNED_POST_FLAG) !== ((newThread.flags?.bitfield ?? 0) & PINNED_POST_FLAG);
  if (!nameChanged && !tagsChanged && !archivedChanged && !lockedChanged && !pinChanged) return;

  const endpoints = await BridgeEndpoint.findAll({
    where: { platform: "discord", channelId: newThread.id, autoMirrored: true },
  });

  for (const endpoint of endpoints) {
    const fluxerSiblings = await BridgeEndpoint.findAll({
      where: { groupId: endpoint.groupId, platform: "fluxer" },
    });
    for (const fluxerEndpoint of fluxerSiblings) {
      const fluxerClient = getFluxerClient(fluxerEndpoint.instanceId);
      if (!fluxerClient) continue;
      const fluxerThread = await fluxerClient.channels.fetch(fluxerEndpoint.channelId).catch(() => null);
      if (!fluxerThread || typeof fluxerThread.isThread !== "function" || !fluxerThread.isThread()) continue;
      if (nameChanged) {
        try {
          await fluxerThread.edit({ name: newThread.name.slice(0, 100) });
        } catch (e) {
          log("FLUXER", `Failed to rename mirrored Fluxer thread ${fluxerEndpoint.channelId}`, e);
        }
      }
      if (tagsChanged) {
        let discordParent = null;
        try {
          discordParent = endpoint.parentEndpointId
            ? await discordClient.channels.fetch((await BridgeEndpoint.findByPk(endpoint.parentEndpointId))?.channelId)
            : null;
        } catch {}
        let fluxerForum = null;
        try {
          fluxerForum = fluxerEndpoint.parentEndpointId
            ? await fluxerClient.channels.fetch((await BridgeEndpoint.findByPk(fluxerEndpoint.parentEndpointId))?.channelId)
            : null;
        } catch {}
        if (discordParent && fluxerForum) {
          const sourceIds = newThread.appliedTags ?? [];
          const mapped = await mapTagsToFluxer(discordParent, sourceIds, discordParent, fluxerForum);
          if (mapped.length > 0 || sourceIds.length === 0) {
            try {
              await fluxerThread.edit({ appliedTags: mapped });
            } catch (e) {
              log("FLUXER", `Failed to update tags on mirrored Fluxer thread ${fluxerEndpoint.channelId}`, e);
            }
          }
        }
      }
      if (archivedChanged || lockedChanged) {
        const patch = {};
        if (archivedChanged && fluxerThread.archived !== newThread.archived) patch.archived = newThread.archived;
        if (lockedChanged && fluxerThread.locked !== newThread.locked) patch.locked = newThread.locked;
        if (patch.archived !== undefined || patch.locked !== undefined) {
          try {
            await fluxerThread.edit(patch);
          } catch (e) {
            log("FLUXER", `Failed to mirror Discord thread close/lock ${fluxerEndpoint.channelId}`, e);
          }
        }
      }
      if (pinChanged) {
        const want = ((newThread.flags?.bitfield ?? 0) & PINNED_POST_FLAG) !== 0;
        const has = (fluxerThread.flags & PINNED_POST_FLAG) !== 0;
        if (has !== want) {
          try {
            await fluxerThread.edit({ flags: (fluxerThread.flags & ~PINNED_POST_FLAG) | (want ? PINNED_POST_FLAG : 0) });
          } catch (e) {
            log("FLUXER", `Failed to mirror Discord thread pin ${fluxerEndpoint.channelId}`, e);
          }
        }
      }
    }
  }
}

/**
 * @param {any} oldThread
 * @param {any} newThread
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @returns {Promise<void>}
 */
export async function mirrorFluxerThreadUpdate(oldThread, newThread, discordClient, fluxerClient) {
  const nameChanged = oldThread.name !== newThread.name;
  const tagsChanged =
    JSON.stringify( (oldThread).appliedTags ?? []) !== JSON.stringify(newThread.appliedTags ?? []);
  const archivedChanged =  (oldThread).archived !== newThread.archived;
  const lockedChanged =  (oldThread).locked !== newThread.locked;
  const pinChanged = ((oldThread.flags ?? 0) & PINNED_POST_FLAG) !== ((newThread.flags ?? 0) & PINNED_POST_FLAG);
  if (!nameChanged && !tagsChanged && !archivedChanged && !lockedChanged && !pinChanged) return;

  const endpoints = await BridgeEndpoint.findAll({
    where: { platform: "fluxer", channelId: newThread.id, autoMirrored: true },
  });

  for (const endpoint of endpoints) {
    const discordSiblings = await BridgeEndpoint.findAll({
      where: { groupId: endpoint.groupId, platform: "discord" },
    });
    for (const discordEndpoint of discordSiblings) {
      const discordThread = await discordClient.channels.fetch(discordEndpoint.channelId).catch(() => null);
      if (!discordThread?.isThread?.()) continue;
      if (nameChanged) {
        try {
          await discordThread.setName((newThread.name ?? "").slice(0, 100));
        } catch (e) {
          log("DISCORD", `Failed to rename mirrored Discord thread ${discordEndpoint.channelId}`, e);
        }
      }
      if (tagsChanged) {
        let fluxerParent = null;
        try {
          fluxerParent = endpoint.parentEndpointId
            ? await fluxerClient.channels.fetch((await BridgeEndpoint.findByPk(endpoint.parentEndpointId))?.channelId)
            : null;
        } catch {}
        let discordForum = null;
        try {
          discordForum = discordEndpoint.parentEndpointId
            ? await discordClient.channels.fetch((await BridgeEndpoint.findByPk(discordEndpoint.parentEndpointId))?.channelId)
            : null;
        } catch {}
        if (fluxerParent && discordForum) {
          const sourceIds = newThread.appliedTags ?? [];
          const mapped = await mapTagsToDiscord(fluxerParent, sourceIds, fluxerParent, discordForum);
          if (mapped.length > 0 || sourceIds.length === 0) {
            try {
              await discordThread.setAppliedTags(mapped);
            } catch (e) {
              log("DISCORD", `Failed to update tags on mirrored Discord thread ${discordEndpoint.channelId}`, e);
            }
          }
        }
      }
      if (archivedChanged || lockedChanged) {
        const patch = {};
        if (archivedChanged && discordThread.archived !== newThread.archived) patch.archived = newThread.archived;
        if (lockedChanged && discordThread.locked !== newThread.locked) patch.locked = newThread.locked;
        if (patch.archived !== undefined || patch.locked !== undefined) {
          try {
            await discordThread.edit(patch);
          } catch (e) {
            log("DISCORD", `Failed to mirror Fluxer thread close/lock ${discordEndpoint.channelId}`, e);
          }
        }
      }
      if (pinChanged) {
        const want = (newThread.flags & PINNED_POST_FLAG) !== 0;
        const has = ((discordThread.flags?.bitfield ?? 0) & PINNED_POST_FLAG) !== 0;
        if (has !== want) {
          try {
            await discordThread.edit({
              flags: ((discordThread.flags?.bitfield ?? 0) & ~PINNED_POST_FLAG) | (want ? PINNED_POST_FLAG : 0),
            });
          } catch (e) {
            log("DISCORD", `Failed to mirror Fluxer thread pin ${discordEndpoint.channelId}`, e);
          }
        }
      }
    }
  }
}

/**
 * @param {any} channel
 * @param {"discord" | "fluxer"} platform
 * @param {import("discord.js").Client} discordClient
 * @returns {Promise<void>}
 */
export async function syncForumTags(channel, platform, discordClient) {
  const endpoints = await BridgeEndpoint.findAll({
    where: { platform, channelId: channel.id, kind: "channel" },
  });

  for (const endpoint of endpoints) {
    const siblings = await BridgeEndpoint.findAll({
      where: { groupId: endpoint.groupId, kind: "channel", channelId: { [Op.ne]: endpoint.channelId } },
    });
    for (const sibling of siblings) {
      if (sibling.platform === platform) continue;
      const sourceClient = platform === "discord" ? discordClient : getFluxerClient(endpoint.instanceId);
      const targetClient = platform === "discord" ? getFluxerClient(sibling.instanceId) : discordClient;
      if (!sourceClient || !targetClient) continue;
      await syncTagsBetween(endpoint, sourceClient, sibling, targetClient, discordClient);
    }
  }
}

async function syncTagsBetween(sourceEndpoint, sourceClient, targetEndpoint, targetClient, discordClient) {
  let source;
  let target;
  try {
    source = await sourceClient.channels.fetch(sourceEndpoint.channelId);
    target = await targetClient.channels.fetch(targetEndpoint.channelId);
  } catch {
    return;
  }
  if (!source || !target) return;

  const targetPlatform = targetEndpoint.platform;
  const isTargetForumOnly =
    targetPlatform === "fluxer"
      ? typeof target.isForum === "function" && (target.isForum() || (typeof target.isMedia === "function" && target.isMedia()))
      : target.type === DiscordChannelType.GuildForum || target.type === DiscordChannelType.GuildMedia;
  if (!isTargetForumOnly) return;
  const sourceForumOnly =
    sourceEndpoint.platform === "discord"
      ? source.type === DiscordChannelType.GuildForum || source.type === DiscordChannelType.GuildMedia
      : typeof source.isForum === "function" && (source.isForum() || (typeof source.isMedia === "function" && source.isMedia()));
  if (!sourceForumOnly) return;

  const sourceTags = readTags(source, sourceEndpoint.platform);
  const targetTags = readTags(target, targetPlatform);
  const targetByName = new Map(targetTags.map(t => [t.name.toLowerCase(), t]));
  const sourceByName = new Map(sourceTags.map(t => [t.name.toLowerCase(), t]));
  const prevTagMap = Array.isArray(sourceEndpoint.tagMap) ? sourceEndpoint.tagMap : [];

  const added = sourceTags.filter(t => !targetByName.has(t.name.toLowerCase()));
  const removed = targetTags.filter(t => {
    if (sourceByName.has(t.name.toLowerCase())) return false;
    const mapped = prevTagMap.find(e => e.name?.toLowerCase() === t.name.toLowerCase());
    return Boolean(sourceEndpoint.platform === "discord" ? mapped?.discordId : mapped?.fluxerId);
  });
  const changed = sourceTags.filter(t => {
    const other = targetByName.get(t.name.toLowerCase());
    return other && other.moderated !== t.moderated;
  });

  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    if (targetPlatform === "fluxer") {
      let current = targetTags;
      for (const tag of removed) {
        if (!tag.id) continue;
        try {
          target = await target.deleteTag(tag.id);
          current = current.filter(t => t.name !== tag.name);
        } catch (e) {
          log("FLUXER", `Failed to delete forum tag ${tag.name} on Fluxer forum ${target.id}`, e);
        }
        await delay(400);
      }
      for (const tag of added) {
        if (current.length >= MAX_FORUM_TAGS) {
          log("FLUXER", `Fluxer forum ${target.id} is at the ${MAX_FORUM_TAGS} tag cap, skipping ${tag.name}`);
          break;
        }
        try {
          target = await target.createTag({ name: tag.name, moderated: tag.moderated });
          current.push({ name: tag.name });
        } catch (e) {
          log("FLUXER", `Failed to create forum tag ${tag.name} on Fluxer forum ${target.id}`, e);
        }
        await delay(400);
      }
      for (const tag of changed) {
        const existing = (target.availableTags ?? []).find(t => t.name.toLowerCase() === tag.name.toLowerCase());
        if (!existing?.id) continue;
        try {
          target = await target.editTag(existing.id, {
            name: tag.name,
            moderated: tag.moderated,
          });
        } catch (e) {
          log("FLUXER", `Failed to edit forum tag ${tag.name} on Fluxer forum ${target.id}`, e);
        }
        await delay(400);
      }
    } else {
      const list = [];
      for (const t of targetTags.filter(t => !removed.some(r => r.name.toLowerCase() === t.name.toLowerCase()))) {
        const src = sourceByName.get(t.name.toLowerCase());
        list.push({
          id: t.id,
          name: t.name,
          moderated: src?.moderated ?? t.moderated,
          emoji: { id: t.emojiId ?? null, name: t.emojiName ?? null },
        });
      }
      for (const tag of added) {
        if (list.length >= MAX_FORUM_TAGS) {
          log("DISCORD", `Discord forum ${target.id} is at the ${MAX_FORUM_TAGS} tag cap, skipping ${tag.name}`);
          break;
        }
        list.push({ name: tag.name, moderated: tag.moderated, emoji: { id: null, name: null } });
      }
      try {
        target = await target.setAvailableTags(list);
      } catch (e) {
        log("DISCORD", `Failed to sync tags on Discord forum ${target.id}`, e);
      }
    }
  }

  const finalTargetTags = readTags(target, targetPlatform);
  const tagMap = [];
  for (const tag of sourceTags) {
    const prev = prevTagMap.find(t => t.name?.toLowerCase() === tag.name.toLowerCase());
    const targetTag = finalTargetTags.find(t => t.name.toLowerCase() === tag.name.toLowerCase());
    tagMap.push({
      name: tag.name,
      moderated: tag.moderated,
      emojiName: tag.emojiName ?? null,
      discordId: sourceEndpoint.platform === "discord" ? tag.id : (targetTag?.id ?? prev?.discordId ?? null),
      fluxerId: sourceEndpoint.platform === "fluxer" ? tag.id : (targetTag?.id ?? prev?.fluxerId ?? null),
    });
  }
  if (JSON.stringify(tagMap) !== JSON.stringify(prevTagMap)) {
    persistTagMap(sourceEndpoint, tagMap);
  }
}
