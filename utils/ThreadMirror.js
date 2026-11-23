import Config from "./ConfigHandler.js";
import { ChannelType as FluxerChannelType } from "@fluxerjs/core";
import { ChannelType as DiscordChannelType } from "discord.js";
import { BridgeEndpoint, BridgeGroup, MessageLink } from "../db/index.js";
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
async function backfillThreadMessages(thread, bridgeMessage) {
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
}

export async function backfillMirroredThread(thread, bridgeMessage, guildId, options = {}) {
  if (options.immediate) return backfillThreadMessages(thread, bridgeMessage);
  return runBackfill(guildId, () => backfillThreadMessages(thread, bridgeMessage));
}

const resumedThreads = new Set();

/**
 * @param {any} thread
 * @param {"discord" | "fluxer"} platform
 * @param {(message: any) => Promise<void>} bridgeMessage
 * @param {string} currentMessageId
 * @param {string | null} relayWebhookId
 * @returns {Promise<boolean>}
 */
export async function resumeThreadBackfill(thread, platform, bridgeMessage, currentMessageId, relayWebhookId = null) {
  const key = `${platform}:${thread.id}`;
  if (resumedThreads.has(key)) return false;
  try {
    const rows = await BridgeEndpoint.findAll({ where: { platform, channelId: thread.id, kind: "thread" } });
    if (rows.length === 0) return false;
    if (relayWebhookId && rows.some(row => row.webhookId === relayWebhookId)) return false;
    resumedThreads.add(key);
    const page = [...(await thread.messages.fetch({ limit: 100 })).values()].filter(m => m.id !== currentMessageId);
    if (page.length === 0) return false;
    const linked = await MessageLink.findAll({
      where: { messageId: { [Op.in]: page.map(m => m.id) }, endpointId: { [Op.in]: rows.map(row => row.id) } },
      attributes: ["messageId"],
      raw: true,
    });
    const linkedIds = new Set(linked.map(row => row.messageId));
    if (page.every(m => linkedIds.has(m.id))) return false;
    log("DEBUG", `resumeThreadBackfill ${platform} thread=${thread.id} unbridged=${page.filter(m => !linkedIds.has(m.id)).length}`);
    await backfillMirroredThread(thread, bridgeMessage, thread.guildId);
    return true;
  } catch (e) {
    log("DEBUG", `resumeThreadBackfill failed ${platform} thread=${thread.id}`, e);
    return false;
  }
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

function tagMapObject(tagMap) {
  if (tagMap && !Array.isArray(tagMap) && tagMap.targets) return { version: 2, targets: { ...tagMap.targets } };
  return { version: 2, targets: {} };
}

function tagEntriesFor(tagMap, targetEndpointId) {
  const entries = tagMapObject(tagMap).targets[targetEndpointId];
  return Array.isArray(entries) ? entries : [];
}

async function persistTagEntries(anchorEndpoint, targetEndpointId, entries) {
  const tagMap = tagMapObject(anchorEndpoint.tagMap);
  tagMap.targets[targetEndpointId] = entries;
  anchorEndpoint.set("tagMap", tagMap);
  await persistTagMap(anchorEndpoint, tagMap);
}

/**
 * @param {BridgeEndpoint} anchorEndpoint
 * @param {BridgeEndpoint} targetEndpoint
 * @param {string[]} tagIds
 * @param {BridgeEndpoint} discordParent
 * @param {BridgeEndpoint} fluxerParent
 * @returns {Promise<string[]>} fluxer tag ids
 */
export async function mapTagsToFluxer(anchorEndpoint, targetEndpoint, tagIds, discordParent, fluxerParent) {
  if (!tagIds?.length || !fluxerParent || !targetEndpoint) return [];
  const entries = [...tagEntriesFor(anchorEndpoint.tagMap, targetEndpoint.id)];
  const sourceTags = discordParent ? readTags(discordParent, "discord") : [];
  let changed = false;
  const ids = [];
  for (const id of tagIds.slice(0, MAX_POST_TAGS)) {
    let entry = entries.find(t => t.discordId === id);
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
      entries.push(entry);
      changed = true;
    }
    if (entry.fluxerId) ids.push(entry.fluxerId);
  }
  if (changed) await persistTagEntries(anchorEndpoint, targetEndpoint.id, entries);
  return ids;
}

/**
 * @param {BridgeEndpoint} anchorEndpoint
 * @param {BridgeEndpoint} targetEndpoint
 * @param {string[]} tagIds
 * @param {BridgeEndpoint} fluxerParent
 * @param {BridgeEndpoint} discordParent
 * @returns {Promise<string[]>} discord tag ids
 */
export async function mapTagsToDiscord(anchorEndpoint, targetEndpoint, tagIds, fluxerParent, discordParent) {
  if (!tagIds?.length || !discordParent || !targetEndpoint) return [];
  const entries = [...tagEntriesFor(anchorEndpoint.tagMap, targetEndpoint.id)];
  const sourceTags = fluxerParent ? readTags(fluxerParent, "fluxer") : [];
  let changed = false;
  const ids = [];
  for (const id of tagIds.slice(0, MAX_POST_TAGS)) {
    let entry = entries.find(t => t.fluxerId === id);
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
      entries.push(entry);
      changed = true;
    }
    if (entry.discordId) ids.push(entry.discordId);
  }
  if (changed) await persistTagEntries(anchorEndpoint, targetEndpoint.id, entries);
  return ids;
}

async function pairedParentEndpoints(parentEndpoint) {
  const siblings = await BridgeEndpoint.findAll({
    where: { groupId: parentEndpoint.groupId, kind: "channel", channelId: { [Op.ne]: parentEndpoint.channelId } },
  });
  return siblings.filter(s => s.channelId !== parentEndpoint.channelId);
}

export async function ensureThreadFamilyLink(sourceRow, sourceMessageId, targetRow, targetMessageId, authorId = null) {
  try {
    const existing = await MessageLink.findOne({ where: { messageId: sourceMessageId, endpointId: sourceRow.id } });
    if (existing) {
      const sibling = await MessageLink.findOne({ where: { linkGroup: existing.linkGroup, endpointId: targetRow.id } });
      if (sibling) return;
      await MessageLink.create({ linkGroup: existing.linkGroup, messageId: targetMessageId, endpointId: targetRow.id, authorId });
      return;
    }
    const linkGroup = newLinkGroup();
    await MessageLink.create({ linkGroup, messageId: sourceMessageId, endpointId: sourceRow.id, authorId });
    await MessageLink.create({ linkGroup, messageId: targetMessageId, endpointId: targetRow.id, authorId });
  } catch (e) {
    log("DB", "Failed to link mirrored thread family", e);
  }
}

export async function ensureThreadRows(specs) {
  if (specs.length === 0) return [];
  const existing = [];
  const groupIds = [];
  for (const spec of specs) {
    const [row] = await BridgeEndpoint.findAll({
      where: { platform: spec.platform, channelId: spec.channelId, kind: "thread" },
      limit: 1,
    });
    existing.push(row ?? null);
    if (row?.groupId != null) groupIds.push(row.groupId);
  }

  let groupId = groupIds[0];
  const groupHasChannels =
    groupId == null ? false : (await BridgeEndpoint.count({ where: { groupId, kind: "channel" } })) > 0;
  if (groupId == null || groupHasChannels) {
    const parentGroupId = specs.find(spec => spec.parentEndpoint?.groupId != null)?.parentEndpoint.groupId;
    const sourceGroupId = groupId ?? parentGroupId;
    const sourceGroup = sourceGroupId != null ? await BridgeGroup.findByPk(sourceGroupId) : null;
    const group = await BridgeGroup.create({ bridgeType: sourceGroup?.bridgeType ?? "both" });
    groupId = group.id;
  }

  const extraGroupIds = [...new Set(groupIds)].filter(id => id !== groupId);
  for (const extraGroupId of extraGroupIds) {
    const hasChannels = (await BridgeEndpoint.count({ where: { groupId: extraGroupId, kind: "channel" } })) > 0;
    if (hasChannels) continue;
    await BridgeEndpoint.update({ groupId }, { where: { groupId: extraGroupId, kind: "thread" } });
    await BridgeGroup.destroy({ where: { id: extraGroupId } });
  }

  const rows = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (existing[i]) {
      if (existing[i].groupId !== groupId) {
        existing[i].groupId = groupId;
        await existing[i].save();
      }
      rows.push(existing[i]);
      continue;
    }
    rows.push(
      await BridgeEndpoint.create({
        groupId,
        platform: spec.platform,
        instanceId: spec.instanceId ?? "default",
        channelId: spec.channelId,
        guildId: spec.guildId,
        webhookId: spec.webhookId,
        webhookToken: spec.webhookToken,
        kind: "thread",
        autoMirrored: true,
        parentEndpointId: spec.parentEndpoint?.id ?? null,
      })
    );
  }

  // Never leave a bridge group behind without endpoints.
  if ((await BridgeEndpoint.count({ where: { groupId } })) === 0) {
    await BridgeGroup.destroy({ where: { id: groupId } });
  }
  return rows;
}

async function existingThreadCopy(destParentEndpoint, sourcePlatform, sourceThreadId) {
  const sourceRows = await BridgeEndpoint.findAll({
    where: { platform: sourcePlatform, channelId: sourceThreadId, kind: "thread" },
    attributes: ["id"],
  });
  if (sourceRows.length === 0) return null;
  const sourceLinks = await MessageLink.findAll({
    where: { endpointId: { [Op.in]: sourceRows.map(row => row.id) } },
    attributes: ["linkGroup"],
    raw: true,
    limit: 200,
  });
  const linkGroups = [...new Set(sourceLinks.map(row => row.linkGroup))];
  if (linkGroups.length === 0) return null;
  const destRows = await BridgeEndpoint.findAll({
    where: { parentEndpointId: destParentEndpoint.id, kind: "thread" },
  });
  if (destRows.length === 0) return null;
  const sibling = await MessageLink.findOne({
    where: { linkGroup: { [Op.in]: linkGroups }, endpointId: { [Op.in]: destRows.map(row => row.id) } },
  });
  return sibling ? (destRows.find(row => row.id === sibling.endpointId) ?? null) : null;
}

async function mapTagsSamePlatformByName(thread, sourceParentEndpoint, sourceParent, targetParent, platform) {
  const sourceTags = sourceParent ? readTags(sourceParent, platform) : [];
  const targetTags = readTags(targetParent, platform);
  const byName = new Map(targetTags.map(t => [t.name.toLowerCase(), t]));
  const applied = [];
  for (const id of thread.appliedTags ?? []) {
    const src = sourceTags.find(t => t.id === id);
    if (!src) continue;
    const target = byName.get(src.name.toLowerCase());
    if (target) applied.push(target);
  }
  return applied;
}

async function mirrorFluxerThreadToFluxer(thread, parentEndpoint, targetParentEndpoint, srcClient, dstClient, claim) {
  const made = [];
  if (await existingThreadCopy(targetParentEndpoint, "fluxer", thread.id)) return made;
  const targetParent = await dstClient.channels.fetch(targetParentEndpoint.channelId).catch(() => null);
  if (!targetParent) return made;
  const isForumParent =
    typeof targetParent.isForum === "function" &&
    (targetParent.isForum() || (typeof targetParent.isMedia === "function" && targetParent.isMedia()));

  if (!isForumParent) {
    let newThreadId = null;
    const starterLink = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: parentEndpoint.id } });
    if (starterLink) {
      const targetStarterLink = await MessageLink.findOne({
        where: { linkGroup: starterLink.linkGroup, endpointId: targetParentEndpoint.id },
      });
      if (targetStarterLink) {
        try {
          const starterMessage = await targetParent.messages.fetch(targetStarterLink.messageId);
          selfCreatedThreads.add("fluxer:" + targetStarterLink.messageId);
          const attached = await starterMessage.startThread({ name: thread.name.slice(0, 100) });
          newThreadId = attached.id;
          log("DEBUG", `autoBridgeFluxerThread attached to Fluxer message ${targetStarterLink.messageId}`);
        } catch (e) {
          if (e?.code === "THREAD_ALREADY_CREATED_FOR_MESSAGE") {
            log("DEBUG", `autoBridgeFluxerThread skip id=${thread.id} reason=fluxerThreadAlreadyAttached`);
            return made;
          }
          log(
            "FLUXER",
            `Couldn't attach mirrored thread to Fluxer message ${targetStarterLink.messageId}, creating a standalone thread`,
            e
          );
        }
      }
    }
    if (!newThreadId) {
      let resolveSelfCreate;
      markSelfCreate(
        `fluxer:${targetParentEndpoint.channelId}`,
        new Promise(r => {
          resolveSelfCreate = r;
        })
      );
      const created = await targetParent.threads.create({
        name: thread.name.slice(0, 100),
        type: thread.type === 10 ? FluxerChannelType.AnnouncementThread : FluxerChannelType.PublicThread,
      });
      resolveSelfCreate(created.id);
      newThreadId = created.id;
    }

    selfCreatedThreads.add("fluxer:" + newThreadId);
    try {
      const [srcRow, dstRow] = await ensureThreadRows([
        {
          parentEndpoint,
          platform: "fluxer",
          instanceId: parentEndpoint.instanceId,
          channelId: thread.id,
          guildId: parentEndpoint.guildId,
          webhookId: parentEndpoint.webhookId,
          webhookToken: parentEndpoint.webhookToken,
        },
        {
          parentEndpoint: targetParentEndpoint,
          platform: "fluxer",
          instanceId: targetParentEndpoint.instanceId,
          channelId: newThreadId,
          guildId: targetParentEndpoint.guildId,
          webhookId: targetParentEndpoint.webhookId,
          webhookToken: targetParentEndpoint.webhookToken,
        },
      ]);
      made.push(srcRow, dstRow);
      log(
        "DEBUG",
        `autoBridgeFluxerThread mirrored fluxer=${thread.id} -> ${newThreadId} instance=${targetParentEndpoint.instanceId ?? "default"}`
      );
      await ensureThreadFamilyLink(srcRow, thread.id, dstRow, newThreadId);
    } finally {
      selfCreatedThreads.delete("fluxer:" + newThreadId);
    }

    return made;
  }

  const headMessage = await fetchStarterWithRetry(() =>
    srcClient.channels.fetch(thread.id).then(c => c.messages.fetch(thread.id))
  );

  let headContent = "";
  let headFiles = [];
  let headEmbeds = [];
  let headUsername;
  let headAvatarUrl;
  let headAuthorId = "";

  if (headMessage) {
    headAuthorId = headMessage.author?.id ?? "";
    if (headAuthorId && !(await canUserBridge("fluxer", headAuthorId, parentEndpoint.guildId))) {
      headContent = "*Thread creator opted-out*";
      headUsername = dstClient.user?.username ?? "Fluxcord";
      headAvatarUrl = dstClient.user?.avatarURL?.() ?? undefined;
      headAuthorId = dstClient.user?.id ?? headAuthorId;
    } else {
      const overSized = [];
      for (const a of headMessage.attachments ?? []) {
        if ((a.size ?? 0) >= MAX_POST_ATTACHMENT_SIZE) {
          overSized.push(`[${a.filename}](<${a.url ?? a.proxyUrl}>)`);
          continue;
        }
        headFiles.push({
          name: a.filename,
          url: a.url ?? a.proxyUrl,
          flags: isFluxerSpoilerAttachment(a) ? SPOILER_ATTACHMENT_FLAG : undefined,
          description: a.description,
        });
      }
      if (overSized.length > 0) headContent += `-# has attachments over 25mb: ${overSized.join(" ")}`;
      headEmbeds = (headMessage.embeds ?? []).filter(x => !isPlatformPreviewEmbed(x, headMessage.content ?? ""));
      if (headMessage.content) headContent += (headContent ? "\n" : "") + sanitizePings(headMessage.content);
      if (headMessage.author) {
        let guildUser;
        try {
          guildUser = await (await dstClient.guilds.fetch(targetParentEndpoint.guildId)).fetchMember(
            headMessage.author.id
          );
        } catch {}
        headUsername = withIndicator(
          guildUser?.displayName ?? headMessage.author.globalName ?? headMessage.author.username,
          "fluxer",
          await resolveNameIndicator(targetParentEndpoint.guildId, parentEndpoint.guildId)
        );
        headAvatarUrl = headMessage.author.avatarURL?.() ?? undefined;
      }
    }
  }

  const headInlined = Boolean(headContent || headFiles.length > 0 || headEmbeds.length > 0);
  const headGone = !headContent && headFiles.length === 0 && headEmbeds.length === 0;
  if (headGone) headContent = "-# Deleted message";

  let appliedTags = [];
  let moderatedTags = [];
  try {
    const sourceParent = await srcClient.channels.fetch(parentEndpoint.channelId);
    const tags = await mapTagsSamePlatformByName(thread, parentEndpoint, sourceParent, targetParent, "fluxer");
    appliedTags = tags.filter(t => !t.moderated).map(t => t.id);
    moderatedTags = tags.filter(t => t.moderated).map(t => t.id);
  } catch {}

  let resolveSelfCreate;
  markSelfCreate(
    `fluxer:${targetParentEndpoint.channelId}`,
    new Promise(r => {
      resolveSelfCreate = r;
    })
  );

  let newThreadId = null;
  let starterMessageId = null;
  try {
    const res = await sendFluxerWebhook(
      targetParentEndpoint.webhookId,
      targetParentEndpoint.webhookToken,
      dstClient,
      {
        content: headContent,
        ...(headGone ? { username: "Deleted message" } : headUsername ? { username: headUsername } : {}),
        ...(headAvatarUrl && !headGone ? { avatar_url: headAvatarUrl } : {}),
        ...(headInlined && headEmbeds.length > 0 ? { embeds: headEmbeds } : {}),
        ...(headInlined && headFiles.length > 0 ? { files: headFiles } : {}),
        thread_name: thread.name.slice(0, 100),
        allowed_mentions: { parse: [] },
        ...(appliedTags.length > 0 ? { applied_tags: appliedTags } : {}),
      }
    );
    newThreadId = res?.channel_id ?? null;
    starterMessageId = res?.id ?? null;
  } catch (e) {
    log("FLUXER", `Failed to mirror Fluxer post ${thread.id} to forum ${targetParentEndpoint.channelId}`, e);
  }
  resolveSelfCreate(newThreadId);
  if (!newThreadId) return made;

  if (moderatedTags.length > 0) {
    try {
      const post = await dstClient.channels.fetch(newThreadId);
      await post.edit({ appliedTags: [...appliedTags, ...moderatedTags] });
    } catch (e) {
      log("FLUXER", `Failed to apply moderated tags on mirrored post ${newThreadId}`, e);
    }
  }

  selfCreatedThreads.add("fluxer:" + newThreadId);
  try {
    const [srcRow, dstRow] = await ensureThreadRows([
      {
        parentEndpoint,
        platform: "fluxer",
        instanceId: parentEndpoint.instanceId,
        channelId: thread.id,
        guildId: parentEndpoint.guildId,
        webhookId: parentEndpoint.webhookId,
        webhookToken: parentEndpoint.webhookToken,
      },
      {
        parentEndpoint: targetParentEndpoint,
        platform: "fluxer",
        instanceId: targetParentEndpoint.instanceId,
        channelId: newThreadId,
        guildId: targetParentEndpoint.guildId,
        webhookId: targetParentEndpoint.webhookId,
        webhookToken: targetParentEndpoint.webhookToken,
      },
    ]);
    made.push(srcRow, dstRow);
    log(
      "DEBUG",
      `autoBridgeFluxerThread mirrored fluxer=${thread.id} -> ${newThreadId} instance=${targetParentEndpoint.instanceId ?? "default"}`
    );

    if (starterMessageId) {
      await ensureThreadFamilyLink(srcRow, thread.id, dstRow, starterMessageId, headAuthorId);
    }
  } finally {
    selfCreatedThreads.delete("fluxer:" + newThreadId);
  }

  return made;
}

async function mirrorDiscordThreadToDiscord(thread, parentEndpoint, targetParentEndpoint, discordClient, claim) {
  const made = [];
  if (await existingThreadCopy(targetParentEndpoint, "discord", thread.id)) return made;
  const targetParent = await discordClient.channels.fetch(targetParentEndpoint.channelId).catch(() => null);
  if (!targetParent) return made;
  const isForumParent =
    targetParent.type === DiscordChannelType.GuildForum || targetParent.type === DiscordChannelType.GuildMedia;

  if (!isForumParent) {
    let newThreadId = null;
    const starterLink = await MessageLink.findOne({ where: { messageId: thread.id, endpointId: parentEndpoint.id } });
    if (starterLink) {
      const targetStarterLink = await MessageLink.findOne({
        where: { linkGroup: starterLink.linkGroup, endpointId: targetParentEndpoint.id },
      });
      if (targetStarterLink) {
        try {
          const starterMessage = await targetParent.messages.fetch(targetStarterLink.messageId);
          selfCreatedThreads.add("discord:" + targetStarterLink.messageId);
          if (starterMessage.thread) {
            newThreadId = starterMessage.thread.id;
          } else {
            const attached = await starterMessage.startThread({ name: thread.name.slice(0, 100), autoArchiveDuration: 1440 });
            newThreadId = attached.id;
          }
          log("DEBUG", `autoBridgeDiscordThread attached to Discord message ${targetStarterLink.messageId}`);
        } catch (e) {
          log(
            "DISCORD",
            `Couldn't attach mirrored thread to Discord message ${targetStarterLink.messageId}, creating a standalone thread`,
            e
          );
        }
      }
    }
    if (!newThreadId) {
      let resolveSelfCreate;
      markSelfCreate(
        `discord:${targetParentEndpoint.channelId}`,
        new Promise(r => {
          resolveSelfCreate = r;
        })
      );
      try {
        const created = await targetParent.threads.create({
          name: thread.name.slice(0, 100),
          type: thread.type === 10 ? DiscordChannelType.AnnouncementThread : DiscordChannelType.PublicThread,
          autoArchiveDuration: 1440,
        });
        newThreadId = created.id;
      } finally {
        resolveSelfCreate(newThreadId ?? null);
      }
    }

    selfCreatedThreads.add("discord:" + newThreadId);
    try {
      const [srcRow, dstRow] = await ensureThreadRows([
        {
          parentEndpoint,
          platform: "discord",
          instanceId: parentEndpoint.instanceId,
          channelId: thread.id,
          guildId: parentEndpoint.guildId,
          webhookId: parentEndpoint.webhookId,
          webhookToken: parentEndpoint.webhookToken,
        },
        {
          parentEndpoint: targetParentEndpoint,
          platform: "discord",
          instanceId: targetParentEndpoint.instanceId ?? "default",
          channelId: newThreadId,
          guildId: targetParentEndpoint.guildId,
          webhookId: targetParentEndpoint.webhookId,
          webhookToken: targetParentEndpoint.webhookToken,
        },
      ]);
      made.push(srcRow, dstRow);
      log(
        "DEBUG",
        `autoBridgeDiscordThread mirrored discord=${thread.id} -> ${newThreadId} guild=${targetParentEndpoint.guildId}`
      );
      await ensureThreadFamilyLink(srcRow, thread.id, dstRow, newThreadId);
    } finally {
      selfCreatedThreads.delete("discord:" + newThreadId);
    }

    return made;
  }

  const headMessage = await fetchStarterWithRetry(() => thread.messages.fetch(thread.id));

  let headContent = "";
  let headFiles = [];
  let headEmbeds = [];
  let headUsername;
  let headAvatarUrl;
  let headAuthorId = "";

  if (headMessage) {
    headAuthorId = headMessage.author?.id ?? "";
    if (headAuthorId && !(await canUserBridge("discord", headAuthorId, parentEndpoint.guildId))) {
      headContent = "*Thread creator opted-out*";
      headUsername = discordClient.user?.displayName ?? discordClient.user?.username ?? "Fluxcord";
      headAvatarUrl = discordClient.user?.displayAvatarURL?.() ?? undefined;
      headAuthorId = discordClient.user?.id ?? headAuthorId;
    } else {
      const overSized = [];
      for (const a of headMessage.attachments?.values() ?? []) {
        const url = a.url ?? a.proxyURL;
        if (a.size >= MAX_POST_ATTACHMENT_SIZE) {
          overSized.push(`[${a.name}](<${url}>)`);
          continue;
        }
        const data = await downloadPostAttachment(url);
        if (!data) {
          overSized.push(`[${a.name}](<${url}>)`);
          continue;
        }
        headFiles.push({
          attachment: data,
          name: toDiscordSpoilerFilename(a.name, isDiscordSpoilerAttachment(a)),
          description: a.description,
        });
      }
      if (overSized.length > 0) headContent += `-# has attachments over 25mb: ${overSized.join(" ")}`;
      headEmbeds = (headMessage.embeds ?? []).filter(x => !isPlatformPreviewEmbed(x, headMessage.content ?? ""));
      if (headMessage.content) headContent += (headContent ? "\n" : "") + sanitizePings(headMessage.content);
      if (headMessage.author) {
        let guildUser;
        try {
          guildUser = await targetParent.guild?.members.fetch(headMessage.author.id);
        } catch {}
        headUsername = withIndicator(
          guildUser?.displayName ?? headMessage.author.displayName ?? "Fluxcord",
          "discord",
          await resolveNameIndicator(targetParentEndpoint.guildId, parentEndpoint.guildId)
        );
        headAvatarUrl = guildUser?.avatarURL?.() ?? headMessage.author.avatarURL?.() ?? undefined;
      }
    }
  }

  const headInlined = Boolean(headContent || headFiles.length > 0 || headEmbeds.length > 0);
  const headGone = !headContent && headFiles.length === 0 && headEmbeds.length === 0;
  if (headGone) headContent = "-# Deleted message";

  let appliedTags = [];
  let moderatedTags = [];
  try {
    const tags = await mapTagsSamePlatformByName(
      thread,
      parentEndpoint,
      thread.parentId ? await discordClient.channels.fetch(thread.parentId) : null,
      targetParent,
      "discord"
    );
    appliedTags = tags.filter(t => !t.moderated).map(t => t.id);
    moderatedTags = tags.filter(t => t.moderated).map(t => t.id);
  } catch {}

  let resolveSelfCreate;
  markSelfCreate(
    `discord:${targetParentEndpoint.channelId}`,
    new Promise(r => {
      resolveSelfCreate = r;
    })
  );

  let newThreadId = null;
  let starterMessageId = null;
  try {
    const webhook = await discordClient.fetchWebhook(targetParentEndpoint.webhookId, targetParentEndpoint.webhookToken);
    const created = await webhook.send({
      content: headContent,
      ...(headGone ? { username: "Deleted message" } : headUsername ? { username: headUsername } : {}),
      ...(headAvatarUrl && !headGone ? { avatarURL: headAvatarUrl } : {}),
      ...(headInlined && headFiles.length > 0
        ? { attachments: await cloudUploadAttachments(discordClient, targetParentEndpoint.channelId, headFiles) }
        : {}),
      ...(headInlined && headEmbeds.length > 0 ? { embeds: headEmbeds } : {}),
      threadName: thread.name.slice(0, 100),
      ...(appliedTags.length > 0 ? { appliedTags } : {}),
      allowedMentions: { parse: [] },
    });
    newThreadId = created.channelId ?? created.id;
    starterMessageId = created.id;
  } catch (e) {
    log("DISCORD", `Failed to mirror Discord post ${thread.id} to forum ${targetParentEndpoint.channelId}`, e);
  }
  resolveSelfCreate(newThreadId);
  if (!newThreadId) return made;

  if (moderatedTags.length > 0) {
    try {
      const post = await discordClient.channels.fetch(newThreadId);
      await post.setAppliedTags([...appliedTags, ...moderatedTags]);
    } catch (e) {
      log("DISCORD", `Failed to apply moderated tags on mirrored post ${newThreadId}`, e);
    }
  }

  selfCreatedThreads.add("discord:" + newThreadId);
  try {
    const [srcRow, dstRow] = await ensureThreadRows([
      {
        parentEndpoint,
        platform: "discord",
        instanceId: parentEndpoint.instanceId,
        channelId: thread.id,
        guildId: parentEndpoint.guildId,
        webhookId: parentEndpoint.webhookId,
        webhookToken: parentEndpoint.webhookToken,
      },
      {
        parentEndpoint: targetParentEndpoint,
        platform: "discord",
        instanceId: targetParentEndpoint.instanceId ?? "default",
        channelId: newThreadId,
        guildId: targetParentEndpoint.guildId,
        webhookId: targetParentEndpoint.webhookId,
        webhookToken: targetParentEndpoint.webhookToken,
      },
    ]);
    made.push(srcRow, dstRow);
    log(
      "DEBUG",
      `autoBridgeDiscordThread mirrored discord=${thread.id} -> ${newThreadId} guild=${targetParentEndpoint.guildId}`
    );

    if (starterMessageId) {
      await ensureThreadFamilyLink(srcRow, thread.id, dstRow, starterMessageId, headAuthorId);
    }
  } finally {
    selfCreatedThreads.delete("discord:" + newThreadId);
  }

  return made;
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
      const fluxerParents = await pairedParentEndpoints(parentEndpoint);

      for (const sibling of fluxerParents) {
        if (sibling.platform === "fluxer") {
          const fluxerClient = getFluxerClient(sibling.instanceId);
          if (!fluxerClient) continue;
          const result = await mirrorDiscordThreadToFluxer(
            thread,
            parentEndpoint,
            sibling,
            discordClient,
            fluxerClient,
            claim
          );
          if (result) made.push(...result);
        } else {
          const result = await mirrorDiscordThreadToDiscord(thread, parentEndpoint, sibling, discordClient, claim);
          if (result) made.push(...result);
        }
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
  if (await existingThreadCopy(fluxerParentEndpoint, "discord", thread.id)) return made;
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
      const appliedTags = await mapTagsToFluxer(
        parentEndpoint,
        fluxerParentEndpoint,
        thread.appliedTags ?? [],
        discordParentChannel,
        fluxerParent
      );
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
    const [discordRow, fluxerRow] = await ensureThreadRows([
      {
        parentEndpoint,
        platform: "discord",
        instanceId: parentEndpoint.instanceId ?? "default",
        channelId: thread.id,
        guildId: parentEndpoint.guildId,
        webhookId: parentEndpoint.webhookId,
        webhookToken: parentEndpoint.webhookToken,
      },
      {
        parentEndpoint: fluxerParentEndpoint,
        platform: "fluxer",
        instanceId: fluxerParentEndpoint.instanceId,
        channelId: fluxerThreadId,
        guildId: fluxerParentEndpoint.guildId,
        webhookId: fluxerParentEndpoint.webhookId,
        webhookToken: fluxerParentEndpoint.webhookToken,
      },
    ]);
    made.push(discordRow, fluxerRow);
    log("DEBUG", `autoBridgeDiscordThread mirrored discord=${thread.id} fluxer=${fluxerThreadId} group=${discordRow.groupId}`);

    await ensureThreadFamilyLink(discordRow, thread.id, fluxerRow, starterMessageId ?? fluxerThreadId, headAuthorId);
  } finally {
    selfCreatedThreads.delete("fluxer:" + fluxerThreadId);
  }

  return made;
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
      const discordParents = await pairedParentEndpoints(parentEndpoint);

      for (const sibling of discordParents) {
        if (sibling.platform === "discord") {
          const result = await mirrorFluxerThreadToDiscord(
            thread,
            parentEndpoint,
            sibling,
            discordClient,
            fluxerClient,
            claim
          );
          if (result) made.push(...result);
        } else {
          const dstClient = getFluxerClient(sibling.instanceId);
          if (!dstClient) continue;
          const result = await mirrorFluxerThreadToFluxer(thread, parentEndpoint, sibling, fluxerClient, dstClient, claim);
          if (result) made.push(...result);
        }
      }
    } catch (e) {
      log("DISCORD", `Failed to auto-bridge Fluxer thread ${thread.id} to group ${parentEndpoint.groupId}`, e);
    }
  }

  settlePendingMirror(claim, made);
  releasePendingMirror(claim);
  return made;
}

export async function ensureThreadFannedOut(
  thread,
  { platform, discordClient, fluxerClient, instanceId, bridgeMessage, backfillOptions }
) {
  if (!thread?.parentId) return [];
  const where = { platform, channelId: thread.parentId, kind: "channel" };
  if (platform === "fluxer" && instanceId) where.instanceId = instanceId;
  const parentEndpoints = await BridgeEndpoint.findAll({ where });
  const made = [];
  for (const parentEndpoint of parentEndpoints) {
    try {
      const group = await BridgeGroup.findByPk(parentEndpoint.groupId);
      if (!group) continue;
      if (platform === "fluxer" ? group.bridgeType === "discord2fluxer" : group.bridgeType === "fluxer2discord") continue;
      const rows =
        platform === "fluxer"
          ? await autoBridgeFluxerThread(thread, [parentEndpoint], discordClient, fluxerClient)
          : await autoBridgeDiscordThread(thread, [parentEndpoint], discordClient);
      if (rows) made.push(...rows);
    } catch (e) {
      log("DEBUG", `ensureThreadFannedOut failed ${platform} thread=${thread.id} parent=${parentEndpoint.channelId}`, e);
    }
  }
  if (made.length > 0 && bridgeMessage) {
    await backfillMirroredThread(thread, bridgeMessage, thread.guildId, backfillOptions);
  }
  return made;
}

async function mirrorFluxerThreadToDiscord(thread, parentEndpoint, discordParentEndpoint, discordClient, fluxerClient, claim) {
  const made = [];
  if (await existingThreadCopy(discordParentEndpoint, "fluxer", thread.id)) return made;
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
      const appliedTags = await mapTagsToDiscord(
        parentEndpoint,
        discordParentEndpoint,
        thread.appliedTags ?? [],
        fluxerSourceParent,
        discordParent
      );
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
    const [row, discordThreadEndpoint] = await ensureThreadRows([
      {
        parentEndpoint,
        platform: "fluxer",
        instanceId: instanceIdFor,
        channelId: thread.id,
        guildId: parentEndpoint.guildId,
        webhookId: parentEndpoint.webhookId,
        webhookToken: parentEndpoint.webhookToken,
      },
      {
        parentEndpoint: discordParentEndpoint,
        platform: "discord",
        instanceId: "default",
        channelId: discordThreadId,
        guildId: discordParentEndpoint.guildId,
        webhookId: discordParentEndpoint.webhookId,
        webhookToken: discordParentEndpoint.webhookToken,
      },
    ]);
    made.push(row, discordThreadEndpoint);
    log("DEBUG", `autoBridgeFluxerThread mirrored discord=${discordThreadId} fluxer=${thread.id} endpointId=${row?.id}`);

    await ensureThreadFamilyLink(row, thread.id, discordThreadEndpoint, discordThreadId, headAuthorId);

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

const selfEditedThreads = new Map();
const SELF_EDIT_TTL_MS = 8000;

export function markSelfEditedThread(platform, threadId) {
  selfEditedThreads.set(`${platform}:${threadId}`, Date.now());
  if (selfEditedThreads.size > 2000) {
    const now = Date.now();
    for (const [key, at] of selfEditedThreads) {
      if (now - at > SELF_EDIT_TTL_MS) selfEditedThreads.delete(key);
    }
  }
}

export function isSelfEditedThread(platform, threadId) {
  const at = selfEditedThreads.get(`${platform}:${threadId}`);
  if (!at) return false;
  if (Date.now() - at > SELF_EDIT_TTL_MS) {
    selfEditedThreads.delete(`${platform}:${threadId}`);
    return false;
  }
  return true;
}

function threadFlags(thread) {
  return typeof thread?.flags === "number" ? thread.flags : (thread?.flags?.bitfield ?? 0);
}

async function applyThreadUpdate(sibling, sourceEndpoint, oldThread, newThread, discordClient) {
  const client = sibling.platform === "discord" ? discordClient : getFluxerClient(sibling.instanceId);
  if (!client) return;
  const target = await client.channels.fetch(sibling.channelId).catch(() => null);
  if (!target || typeof target.isThread !== "function" || !target.isThread()) return;

  if (oldThread.name !== newThread.name) {
    try {
      if (sibling.platform === "discord") await target.setName((newThread.name ?? "").slice(0, 100));
      else await target.edit({ name: (newThread.name ?? "").slice(0, 100) });
    } catch (e) {
      log("DEBUG", `Failed to rename mirrored thread ${sibling.platform}:${sibling.channelId}`, e);
    }
  }

  const tagsChanged = JSON.stringify(oldThread.appliedTags ?? []) !== JSON.stringify(newThread.appliedTags ?? []);
  if (tagsChanged) {
    const sourceParentEndpoint = sourceEndpoint.parentEndpointId
      ? await BridgeEndpoint.findByPk(sourceEndpoint.parentEndpointId)
      : null;
    const targetParentEndpoint = sibling.parentEndpointId ? await BridgeEndpoint.findByPk(sibling.parentEndpointId) : null;
    const sourceClient =
      sourceEndpoint.platform === "discord" ? discordClient : getFluxerClient(sourceEndpoint.instanceId);
    if (sourceParentEndpoint && targetParentEndpoint && sourceClient) {
      const sourceParent = await sourceClient.channels.fetch(sourceParentEndpoint.channelId).catch(() => null);
      const targetParent = await client.channels.fetch(targetParentEndpoint.channelId).catch(() => null);
      if (sourceParent && targetParent) {
        const sourceIds = newThread.appliedTags ?? [];
        let ids = [];
        if (sibling.platform === sourceEndpoint.platform) {
          const mapped = await mapTagsSamePlatformByName(
            { appliedTags: sourceIds },
            sourceParentEndpoint,
            sourceParent,
            targetParent,
            sourceEndpoint.platform
          );
          ids = mapped.map(tag => tag.id);
        } else if (sibling.platform === "fluxer") {
          ids = await mapTagsToFluxer(sourceParentEndpoint, targetParentEndpoint, sourceIds, sourceParent, targetParent);
        } else {
          ids = await mapTagsToDiscord(sourceParentEndpoint, targetParentEndpoint, sourceIds, sourceParent, targetParent);
        }
        if (ids.length > 0 || sourceIds.length === 0) {
          try {
            if (sibling.platform === "discord") await target.setAppliedTags(ids);
            else await target.edit({ appliedTags: ids });
          } catch (e) {
            log("DEBUG", `Failed to update tags on mirrored thread ${sibling.platform}:${sibling.channelId}`, e);
          }
        }
      }
    }
  }

  const archivedChanged = oldThread.archived !== newThread.archived;
  const lockedChanged = oldThread.locked !== newThread.locked;
  if (archivedChanged || lockedChanged) {
    const patch = {};
    if (archivedChanged && target.archived !== newThread.archived) patch.archived = newThread.archived;
    if (lockedChanged && target.locked !== newThread.locked) patch.locked = newThread.locked;
    if (patch.archived !== undefined || patch.locked !== undefined) {
      try {
        await target.edit(patch);
      } catch (e) {
        log("DEBUG", `Failed to mirror thread close/lock ${sibling.platform}:${sibling.channelId}`, e);
      }
    }
  }

  const pinChanged = (threadFlags(oldThread) & PINNED_POST_FLAG) !== (threadFlags(newThread) & PINNED_POST_FLAG);
  if (pinChanged) {
    const want = (threadFlags(newThread) & PINNED_POST_FLAG) !== 0;
    const flags = threadFlags(target);
    if (((flags & PINNED_POST_FLAG) !== 0) !== want) {
      try {
        await target.edit({ flags: (flags & ~PINNED_POST_FLAG) | (want ? PINNED_POST_FLAG : 0) });
      } catch (e) {
        log("DEBUG", `Failed to mirror thread pin ${sibling.platform}:${sibling.channelId}`, e);
      }
    }
  }
}

export async function mirrorThreadUpdate(sourceEndpoint, oldThread, newThread, { discordClient }) {
  if (isSelfEditedThread(sourceEndpoint.platform, newThread.id)) return;
  const siblings = await BridgeEndpoint.findAll({
    where: { groupId: sourceEndpoint.groupId, kind: "thread", id: { [Op.ne]: sourceEndpoint.id } },
  });
  for (const sibling of siblings) {
    await applyThreadUpdate(sibling, sourceEndpoint, oldThread, newThread, discordClient);
  }
}

/**
 * @param {any} oldThread
 * @param {any} newThread
 * @param {import("discord.js").Client} discordClient
 * @returns {Promise<void>}
 */
export async function mirrorDiscordThreadUpdate(oldThread, newThread, discordClient) {
  const endpoints = await BridgeEndpoint.findAll({
    where: { platform: "discord", channelId: newThread.id, autoMirrored: true },
  });
  for (const endpoint of endpoints) {
    await mirrorThreadUpdate(endpoint, oldThread, newThread, { discordClient });
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
  const endpoints = await BridgeEndpoint.findAll({
    where: { platform: "fluxer", channelId: newThread.id, autoMirrored: true },
  });
  for (const endpoint of endpoints) {
    await mirrorThreadUpdate(endpoint, oldThread, newThread, { discordClient, fluxerClient });
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
      const sourceClient = platform === "discord" ? discordClient : getFluxerClient(endpoint.instanceId);
      const targetClient =
        sibling.platform === "discord" ? discordClient : getFluxerClient(sibling.instanceId);
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
  const prevTagMap = tagEntriesFor(sourceEndpoint.tagMap, targetEndpoint.id);

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
    await persistTagEntries(sourceEndpoint, targetEndpoint.id, tagMap);
  }
}
