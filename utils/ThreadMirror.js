import { ChannelType as FluxerChannelType } from "@fluxerjs/core";
import { ChannelType as DiscordChannelType } from "discord.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { Op } from "sequelize";
import { sanitizePings } from "./SanitizePings.js";
import { sendFluxerWebhook } from "./FluxerWebhookSend.js";
import { cloudUploadAttachments } from "./CloudUpload.js";
import { resolveNameIndicator, withIndicator } from "./NameIndicator.js";
import { discordEmbedToFluxer, fluxerEmbedToDiscord } from "./EmbedConverter.js";
import { isDiscordSpoilerAttachment, isFluxerSpoilerAttachment, SPOILER_ATTACHMENT_FLAG, toDiscordSpoilerFilename } from "./SpoilerAttachments.js";
import { log } from "./Logger.js";

const MAX_POST_TAGS = 5;
const MAX_FORUM_TAGS = 20;

const pendingMirrors = new Map();

function claimPendingMirror(platform, threadId) {
  const key = `${platform}:${threadId}`;
  if (pendingMirrors.has(key)) return null;
  let resolve;
  const promise = new Promise(res => {
    resolve = res;
  });
  const claim = { key, promise, resolve };
  pendingMirrors.set(key, claim);
  return claim;
}

function settlePendingMirror(claim, value) {
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

const backfillLimit = 1000;

export async function backfillMirroredThread(thread, bridgeMessage) {
  const page = await thread.messages.fetch({ limit: backfillLimit });
  for (const message of [...page.values()].reverse()) {
    const existing = await MessageMap.findOne({
      where: { [Op.or]: [{ discordMessageId: message.id }, { fluxerMessageId: message.id }] },
    });
    if (existing) continue;
    try {
      await bridgeMessage(message);
    } catch {}
    await delay(500);
  }
}

export async function waitForPendingMirror(platform, threadId) {
  const claim = pendingMirrors.get(`${platform}:${threadId}`);
  if (!claim) return null;
  try {
    return await claim.promise;
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

async function persistTagMap(anchorRow, tagMap) {
  const row = await ChannelMap.findOne({ where: { id: anchorRow.id } });
  if (!row) return;
  row.set("tagMap", tagMap);
  await row.save();
}

export async function mapTagsToFluxer(anchorRow, tagIds, discordParent, fluxerParent) {
  if (!tagIds?.length || !fluxerParent) return [];
  const tagMap = Array.isArray(anchorRow.tagMap) ? anchorRow.tagMap : [];
  const sourceTags = discordParent ? readTags(discordParent, "discord") : [];
  let changed = false;
  const ids = [];
  for (const id of tagIds.slice(0, MAX_POST_TAGS)) {
    let entry = tagMap.find(t => t.discordId === id);
    if (!entry) {
      const sourceTag = sourceTags.find(t => t.id === id);
      if (!sourceTag) continue;
      const fluxerTag = (fluxerParent.availableTags ?? []).find(
        t => t.name.toLowerCase() === sourceTag.name.toLowerCase()
      );
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
  if (changed) await persistTagMap(anchorRow, tagMap);
  return ids;
}

export async function mapTagsToDiscord(anchorRow, tagIds, fluxerParent, discordParent) {
  if (!tagIds?.length || !discordParent) return [];
  const tagMap = Array.isArray(anchorRow.tagMap) ? anchorRow.tagMap : [];
  const sourceTags = fluxerParent ? readTags(fluxerParent, "fluxer") : [];
  let changed = false;
  const ids = [];
  for (const id of tagIds.slice(0, MAX_POST_TAGS)) {
    let entry = tagMap.find(t => t.fluxerId === id);
    if (!entry) {
      const sourceTag = sourceTags.find(t => t.id === id);
      if (!sourceTag) continue;
      const discordTag = (discordParent.availableTags ?? []).find(
        t => t.name.toLowerCase() === sourceTag.name.toLowerCase()
      );
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
  if (changed) await persistTagMap(anchorRow, tagMap);
  return ids;
}

export async function fluxerThreadIdFor(fluxerClient, channelMap) {
  if (!channelMap?.autoMirrored || !channelMap.fluxerChannelId) return null;
  let channel;
  try {
    channel = await fluxerClient.channels.fetch(channelMap.fluxerChannelId);
  } catch {
    return null;
  }
  if (typeof channel?.isThread !== "function" || !channel.isThread()) return null;
  if (channel.archived) {
    try {
      await channel.setArchived(false);
    } catch (e) {
      log("FLUXER", `Failed to unarchive bridged Fluxer thread ${channelMap.fluxerChannelId}`, e);
    }
  }
  return channelMap.fluxerChannelId;
}

export async function fluxerWebhookChannelIdFor(channelMap) {
  if (!channelMap?.autoMirrored || !channelMap.parentChannelMapId) return channelMap?.fluxerChannelId ?? null;
  const parentRow = await ChannelMap.findOne({ where: { id: channelMap.parentChannelMapId }, raw: true });
  return parentRow?.fluxerChannelId ?? channelMap.fluxerChannelId;
}

export async function autoBridgeDiscordThread(thread, parentMap, discordClient, fluxerClient) {
  const claim = claimPendingMirror("discord", thread.id);
  if (!claim) {
    log("DEBUG", `autoBridgeDiscordThread skip id=${thread.id} reason=pendingMirror`);
    return waitForPendingMirror("discord", thread.id);
  }
  log("DEBUG", `autoBridgeDiscordThread start id=${thread.id} name=${thread.name} parentMapId=${parentMap.id}`);

  let siblingClaim = null;
  try {
    const existing = await ChannelMap.findOne({
      where: { [Op.or]: [{ discordChannelId: thread.id }, { fluxerChannelId: thread.id }] },
      raw: true,
    });
    if (existing) {
      log("DEBUG", `autoBridgeDiscordThread skip id=${thread.id} reason=rowExists`);
      settlePendingMirror(claim, null);
      return null;
    }

    const fluxerParent = await fluxerClient.channels.fetch(parentMap.fluxerChannelId);

    let fluxerThreadId = null;
    let starterMessageId = null;
    let attachedToStarter = false;
    let headInlined = false;
    let headAuthorId = "";
    if (typeof fluxerParent.isForum === "function" && (fluxerParent.isForum() || fluxerParent.isMedia())) {
      const headMessage = await fetchStarterWithRetry(() =>
        discordClient.channels.fetch(thread.id).then(c => c.messages.fetch(thread.id))
      );
      let starterMap = await MessageMap.findOne({
        where: { discordMessageId: thread.id, channelMapId: parentMap.id },
      });
      if (!starterMap && headMessage?.webhookId === parentMap.discordWebhookId) {
        for (let i = 0; i < 12 && !starterMap; i++) {
          await delay(250);
          starterMap = await MessageMap.findOne({
            where: { discordMessageId: thread.id, channelMapId: parentMap.id },
          });
        }
      }
      if (starterMap) {
        fluxerThreadId = starterMap.fluxerMessageId;
        attachedToStarter = true;
        log("DEBUG", `autoBridgeDiscordThread attached to Fluxer post ${fluxerThreadId}`);
      } else {
        let discordParent = null;
        try {
          discordParent = await discordClient.channels.fetch(parentMap.discordChannelId);
        } catch {}
        const appliedTags = await mapTagsToFluxer(parentMap, thread.appliedTags ?? [], discordParent, fluxerParent);
        let headContent = "";
        let headUsername;
        let headAvatarUrl;
        let headEmbeds = [];
        let headFiles = [];
        if (headMessage) {
          headAuthorId = headMessage.author?.id ?? "";
          headContent = headMessage.content ? sanitizePings(headMessage.content) : "";
          headEmbeds = await Promise.all(
            (headMessage.embeds ?? [])
              .filter(x => !x.url || !headContent.includes(x.url))
              .map(async x => await discordEmbedToFluxer(x, fluxerClient))
          );
          const overSized = [];
          for (const a of headMessage.attachments?.values() ?? []) {
            if (a.size >= MAX_POST_ATTACHMENT_SIZE) {
              overSized.push(`[${a.name}](<${a.proxyURL ?? a.url}>)`);
              continue;
            }
            headFiles.push({
              name: a.name,
              url: a.proxyURL ?? a.url,
              flags: isDiscordSpoilerAttachment(a) ? SPOILER_ATTACHMENT_FLAG : undefined,
              description: a.description,
            });
          }
          if (overSized.length > 0) {
            headContent += (headContent ? "\n" : "") + `-# has attachments over 25mb: ${overSized.join(" ")}`;
          }
          headInlined = Boolean(headContent || headFiles.length > 0 || headEmbeds.length > 0);
          if (headMessage.author) {
            headUsername = withIndicator(
              headMessage.author.displayName ?? headMessage.author.globalName ?? "Fluxcord",
              "discord",
              await resolveNameIndicator(parentMap.fluxerGuildId, parentMap.discordGuildId)
            );
            let guildUser;
            try {
              guildUser = await thread.guild?.members.fetch(headMessage.author.id);
            } catch {}
            headAvatarUrl = guildUser?.avatarURL() ?? headMessage.author.avatarURL() ?? undefined;
          }
        }
        let resolveSelfCreate;
        markSelfCreate(
          `fluxer:${parentMap.fluxerChannelId}`,
          new Promise(r => {
            resolveSelfCreate = r;
          })
        );
        const headGone = !headContent && headFiles.length === 0 && headEmbeds.length === 0;
        if (headGone) headContent = "-# Deleted message";
        const res = await sendFluxerWebhook(parentMap.fluxerWebhookId, parentMap.fluxerWebhookToken, fluxerClient, {
          content: headContent,
          ...(headGone ? { username: "Deleted message" } : headUsername ? { username: headUsername } : {}),
          ...(headAvatarUrl && !headGone ? { avatar_url: headAvatarUrl } : {}),
          ...(headInlined && headEmbeds.length > 0 ? { embeds: headEmbeds } : {}),
          ...(headInlined && headFiles.length > 0 ? { files: headFiles } : {}),
          thread_name: thread.name.slice(0, 100),
          allowed_mentions: { parse: [] },
          ...(appliedTags.length > 0 ? { applied_tags: appliedTags } : {}),
        });
        fluxerThreadId = res?.channel_id ?? null;
        starterMessageId = res?.id ?? null;
        if (headGone && starterMessageId) {
          try {
            await fluxerClient.rest.delete(
              `/webhooks/${parentMap.fluxerWebhookId}/${parentMap.fluxerWebhookToken}/messages/${starterMessageId}?thread_id=${fluxerThreadId}`,
              { auth: false }
            );
          } catch (e) {
            log("FLUXER", `Failed to remove the deleted head placeholder of mirrored post ${fluxerThreadId}`, e);
          }
          starterMessageId = null;
        }
        resolveSelfCreate(fluxerThreadId);
      }
    } else {
      const starterMap = await MessageMap.findOne({
        where: { discordMessageId: thread.id, channelMapId: parentMap.id },
      });
      if (starterMap) {
        try {
          const starterMessage = await fluxerParent.messages.fetch(starterMap.fluxerMessageId);
          selfCreatedThreads.add("fluxer:" + starterMap.fluxerMessageId);
          const attached = await starterMessage.startThread({ name: thread.name.slice(0, 100) });
          fluxerThreadId = attached.id;
          attachedToStarter = true;
          log("DEBUG", `autoBridgeDiscordThread attached to Fluxer message ${starterMap.fluxerMessageId}`);
        } catch (e) {
          if (e?.code === "THREAD_ALREADY_CREATED_FOR_MESSAGE") {
            log("DEBUG", `autoBridgeDiscordThread skip id=${thread.id} reason=discordThreadAlreadyAttached`);
            settlePendingMirror(claim, null);
            releasePendingMirror(claim);
            return null;
          }
          log(
            "FLUXER",
            `Couldn't attach mirrored thread to Fluxer message ${starterMap.fluxerMessageId}, creating a standalone thread`,
            e
          );
        }
      }
      if (!fluxerThreadId) {
        let resolveSelfCreate;
        markSelfCreate(
          `fluxer:${parentMap.fluxerChannelId}`,
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

    if (attachedToStarter) {
      const sibling = claimPendingMirror("fluxer", fluxerThreadId);
      if (sibling) {
        siblingClaim = sibling;
      } else {
        const siblingRow = await Promise.race([waitForPendingMirror("fluxer", fluxerThreadId), delay(1500).then(() => null)]);
        if (siblingRow) {
          log("DEBUG", `autoBridgeDiscordThread join sibling mirror discord=${thread.id} fluxer=${fluxerThreadId}`);
          settlePendingMirror(claim, siblingRow);
          releasePendingMirror(claim);
          return siblingRow;
        }
      }
    }
    const siblingRow = await ChannelMap.findOne({
      where: { [Op.or]: [{ discordChannelId: thread.id }, { fluxerChannelId: thread.id }] },
      raw: true,
    });
    if (siblingRow) {
      log("DEBUG", `autoBridgeDiscordThread skip id=${thread.id} reason=siblingMirror`);
      settlePendingMirror(claim, siblingRow);
      if (siblingClaim) settlePendingMirror(siblingClaim, siblingRow);
      return siblingRow;
    }

    selfCreatedThreads.add("fluxer:" + fluxerThreadId);
    try {
      const row = await ChannelMap.create({
        discordGuildId: parentMap.discordGuildId,
        discordChannelId: thread.id,
        discordWebhookId: parentMap.discordWebhookId,
        discordWebhookToken: parentMap.discordWebhookToken,
        fluxerGuildId: parentMap.fluxerGuildId,
        fluxerChannelId: fluxerThreadId,
        fluxerWebhookId: parentMap.fluxerWebhookId,
        fluxerWebhookToken: parentMap.fluxerWebhookToken,
        bridgeType: parentMap.bridgeType,
        fluxerGuildMapId: parentMap.fluxerGuildMapId,
        discordGuildMapId: parentMap.discordGuildMapId,
        autoMirrored: true,
        parentChannelMapId: parentMap.id,
      });
      log("DEBUG", `autoBridgeDiscordThread mirrored discord=${thread.id} fluxer=${fluxerThreadId} rowId=${row.id}`);

      if (starterMessageId && headInlined) {
        try {
          await MessageMap.create({
            messageSource: "discord",
            discordMessageId: thread.id,
            fluxerMessageId: starterMessageId,
            channelMapId: row.id,
            authorId: headAuthorId,
          });
        } catch (e) {
          log("DB", "Failed to map bridged thread starter message", e);
        }
      }

      settlePendingMirror(claim, row);
      if (siblingClaim) settlePendingMirror(siblingClaim, row);
      return row;
    } finally {
      selfCreatedThreads.delete("fluxer:" + fluxerThreadId);
    }
  } catch (e) {
    settlePendingMirror(claim, null);
    if (siblingClaim) settlePendingMirror(siblingClaim, null);
    throw e;
  } finally {
    releasePendingMirror(claim);
    if (siblingClaim) releasePendingMirror(siblingClaim);
  }
}

export async function autoBridgeFluxerThread(thread, parentMap, discordClient, fluxerClient) {
  const claim = claimPendingMirror("fluxer", thread.id);
  if (!claim) {
    log("DEBUG", `autoBridgeFluxerThread skip id=${thread.id} reason=pendingMirror`);
    return waitForPendingMirror("fluxer", thread.id);
  }
  log("DEBUG", `autoBridgeFluxerThread start id=${thread.id} name=${thread.name} parentMapId=${parentMap.id}`);

  let siblingClaim = null;
  try {
    const existing = await ChannelMap.findOne({
      where: { [Op.or]: [{ discordChannelId: thread.id }, { fluxerChannelId: thread.id }] },
      raw: true,
    });
    if (existing) {
      log("DEBUG", `autoBridgeFluxerThread skip id=${thread.id} reason=rowExists`);
      settlePendingMirror(claim, null);
      return null;
    }

    const discordParent = await discordClient.channels.fetch(parentMap.discordChannelId);
    if (!discordParent) {
      settlePendingMirror(claim, null);
      return null;
    }

    const isForumParent =
      discordParent.type === DiscordChannelType.GuildForum || discordParent.type === DiscordChannelType.GuildMedia;

    let fluxerSourceParent = null;
    try {
      fluxerSourceParent = await fluxerClient.channels.fetch(parentMap.fluxerChannelId);
    } catch {}

    let discordThreadId;
    let attachedToStarter = false;
    let headInlined = false;
    let headAuthorId = "";
    if (!isForumParent) {
      const starterMap = await MessageMap.findOne({
        where: { fluxerMessageId: thread.id, channelMapId: parentMap.id },
      });
      if (starterMap) {
        try {
          const starterMessage = await discordParent.messages.fetch(starterMap.discordMessageId);
          selfCreatedThreads.add("discord:" + starterMap.discordMessageId);
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
            settlePendingMirror(claim, null);
            releasePendingMirror(claim);
            return null;
          }
          log(
            "DISCORD",
            `Couldn't attach mirrored thread to Discord message ${starterMap.discordMessageId}, creating a standalone thread`,
            e
          );
        }
      }
    }
    if (attachedToStarter) {
      const sibling = claimPendingMirror("discord", discordThreadId);
      if (sibling) {
        siblingClaim = sibling;
      } else {
        const siblingRow = await Promise.race([waitForPendingMirror("discord", discordThreadId), delay(1500).then(() => null)]);
        if (siblingRow) {
          log("DEBUG", `autoBridgeFluxerThread join sibling mirror discord=${discordThreadId} fluxer=${thread.id}`);
          settlePendingMirror(claim, siblingRow);
          releasePendingMirror(claim);
          return siblingRow;
        }
      }
    }
    if (!discordThreadId && isForumParent) {
      const headMessage = await fetchStarterWithRetry(() =>
        fluxerClient.channels.fetch(thread.id).then(c => c.messages.fetch(thread.id))
      );
      let starterMap = await MessageMap.findOne({
        where: { fluxerMessageId: thread.id, channelMapId: parentMap.id },
      });
      if (!starterMap && headMessage?.author?.id === parentMap.fluxerWebhookId) {
        for (let i = 0; i < 12 && !starterMap; i++) {
          await delay(250);
          starterMap = await MessageMap.findOne({
            where: { fluxerMessageId: thread.id, channelMapId: parentMap.id },
          });
        }
      }
      if (starterMap) {
        discordThreadId = starterMap.discordMessageId;
        attachedToStarter = true;
        log("DEBUG", `autoBridgeFluxerThread attached to Discord post ${discordThreadId}`);
      } else {
        let resolveSelfCreate;
        markSelfCreate(
          `discord:${discordParent.id}`,
          new Promise(r => {
            resolveSelfCreate = r;
          })
        );
        const appliedTags = await mapTagsToDiscord(parentMap, thread.appliedTags ?? [], fluxerSourceParent, discordParent);
        let headContent = "";
        let headFiles = [];
        let headEmbeds = [];
        let headUsername;
        let headAvatarUrl;
        if (headMessage) {
          headAuthorId = headMessage.author?.id ?? "";
          const files = [];
          const overSized = [];
          for (const a of headMessage.attachments?.values?.() ?? []) {
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
            headUsername = withIndicator(
              headMessage.author.globalName ?? headMessage.author.username,
              "fluxer",
              await resolveNameIndicator(parentMap.discordGuildId, parentMap.fluxerGuildId)
            );
            headAvatarUrl = headMessage.author.avatarURL?.() ?? undefined;
          }
        }
        const headGone = !headContent && headFiles.length === 0 && headEmbeds.length === 0;
        if (headGone) headContent = "-# Deleted message";
        const webhook = await discordClient.fetchWebhook(parentMap.discordWebhookId, parentMap.discordWebhookToken);
        const created = await webhook.send({
          content: headContent,
          ...(headGone ? { username: "Deleted message" } : headUsername ? { username: headUsername } : {}),
          ...(headAvatarUrl && !headGone ? { avatarURL: headAvatarUrl } : {}),
          ...(headInlined && headFiles.length > 0
            ? { attachments: await cloudUploadAttachments(discordClient, discordParent.id, headFiles) }
            : {}),
          ...(headInlined && headEmbeds.length > 0 ? { embeds: headEmbeds } : {}),
          threadName: thread.name.slice(0, 100),
          ...(appliedTags.length > 0 ? { appliedTags } : {}),
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
      }
    } else if (!discordThreadId && discordParent.type === DiscordChannelType.GuildAnnouncement) {
      const created = await discordParent.threads.create({
        name: thread.name.slice(0, 100),
        type: DiscordChannelType.AnnouncementThread,
      });
      discordThreadId = created.id;
    } else if (!discordThreadId) {
      const created = await discordParent.threads.create({
        name: thread.name.slice(0, 100),
        type: DiscordChannelType.PublicThread,
        autoArchiveDuration: 1440,
      });
      discordThreadId = created.id;
    }

    const siblingRow = await ChannelMap.findOne({
      where: { [Op.or]: [{ discordChannelId: thread.id }, { fluxerChannelId: thread.id }] },
      raw: true,
    });
    if (siblingRow) {
      log("DEBUG", `autoBridgeFluxerThread skip id=${thread.id} reason=siblingMirror`);
      settlePendingMirror(claim, siblingRow);
      if (siblingClaim) settlePendingMirror(siblingClaim, siblingRow);
      return siblingRow;
    }

    selfCreatedThreads.add("discord:" + discordThreadId);
    try {
      const row = await ChannelMap.create({
        discordGuildId: parentMap.discordGuildId,
        discordChannelId: discordThreadId,
        discordWebhookId: parentMap.discordWebhookId,
        discordWebhookToken: parentMap.discordWebhookToken,
        fluxerGuildId: parentMap.fluxerGuildId,
        fluxerChannelId: thread.id,
        fluxerWebhookId: parentMap.fluxerWebhookId,
        fluxerWebhookToken: parentMap.fluxerWebhookToken,
        bridgeType: parentMap.bridgeType,
        fluxerGuildMapId: parentMap.fluxerGuildMapId,
        discordGuildMapId: parentMap.discordGuildMapId,
        autoMirrored: true,
        parentChannelMapId: parentMap.id,
      });
      log("DEBUG", `autoBridgeFluxerThread mirrored discord=${discordThreadId} fluxer=${thread.id} rowId=${row.id}`);

      if (!attachedToStarter) {
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
            await MessageMap.create({
              messageSource: "fluxer",
              discordMessageId: discordStarterId,
              fluxerMessageId: thread.id,
              channelMapId: row.id,
              authorId: headAuthorId,
            });
          } catch (e) {
            log("DB", "Failed to map bridged thread starter message", e);
          }
        }
      }

      settlePendingMirror(claim, row);
      if (siblingClaim) settlePendingMirror(siblingClaim, row);
      return row;
    } finally {
      selfCreatedThreads.delete("discord:" + discordThreadId);
    }
  } catch (e) {
    settlePendingMirror(claim, null);
    if (siblingClaim) settlePendingMirror(siblingClaim, null);
    throw e;
  } finally {
    releasePendingMirror(claim);
    if (siblingClaim) releasePendingMirror(siblingClaim);
  }
}

export async function cleanupMirroredRow(row, discordClient, fluxerClient, skipPlatform) {
  if (skipPlatform !== "discord") {
    try {
      const discordThread = await discordClient.channels.fetch(row.discordChannelId);
      await discordThread.delete();
    } catch (e) {
      log("DISCORD", `Failed to delete mirrored Discord thread ${row.discordChannelId}`, e);
    }
  }
  if (skipPlatform !== "fluxer") {
    try {
      const fluxerThread = await fluxerClient.channels.fetch(row.fluxerChannelId);
      await fluxerThread.delete();
    } catch (e) {
      log("FLUXER", `Failed to delete mirrored Fluxer thread ${row.fluxerChannelId}`, e);
    }
  }
}

export async function syncForumTags(channel, platform, discordClient, fluxerClient) {
  const row = await ChannelMap.findOne({
    where: platform === "discord" ? { discordChannelId: channel.id } : { fluxerChannelId: channel.id },
  });
  if (!row) return;

  let target;
  try {
    target =
      platform === "discord"
        ? await fluxerClient.channels.fetch(row.fluxerChannelId)
        : await discordClient.channels.fetch(row.discordChannelId);
  } catch {
    return;
  }
  if (!target) return;

  const targetPlatform = platform === "discord" ? "fluxer" : "discord";
  const isTargetThreadOnly =
    targetPlatform === "fluxer"
      ? typeof target.isForum === "function" && (target.isForum() || (typeof target.isMedia === "function" && target.isMedia()))
      : target.type === DiscordChannelType.GuildForum || target.type === DiscordChannelType.GuildMedia;
  if (!isTargetThreadOnly) return;

  const sourceTags = readTags(channel, platform);
  const targetTags = readTags(target, targetPlatform);
  const targetByName = new Map(targetTags.map(t => [t.name.toLowerCase(), t]));
  const sourceByName = new Map(sourceTags.map(t => [t.name.toLowerCase(), t]));
  const prevTagMap = Array.isArray(row.tagMap) ? row.tagMap : [];

  const added = sourceTags.filter(t => !targetByName.has(t.name.toLowerCase()));
  const removed = targetTags.filter(t => {
    if (sourceByName.has(t.name.toLowerCase())) return false;
    const mapped = prevTagMap.find(e => e.name?.toLowerCase() === t.name.toLowerCase());
    return Boolean(platform === "discord" ? mapped?.discordId : mapped?.fluxerId);
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
      discordId: platform === "discord" ? tag.id : (targetTag?.id ?? prev?.discordId ?? null),
      fluxerId: platform === "fluxer" ? tag.id : (targetTag?.id ?? prev?.fluxerId ?? null),
    });
  }
  if (JSON.stringify(tagMap) !== JSON.stringify(prevTagMap)) {
    row.set("tagMap", tagMap);
    await row.save();
  }
}
