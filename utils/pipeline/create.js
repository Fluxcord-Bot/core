import { MessageLink, BridgeEndpoint } from "../../db/index.js";
import { MessageType } from "discord.js";
import { sendErrorMessage } from "../SendErrorMessage.js";
import { findEndpoints, newLinkGroup, ensureLink } from "../Bridging.js";
import { waitForMessageMap } from "../WaitForMessageMap.js";
import { canUserBridge, promptOptedOutUserOnFirstMessage } from "../UserOptOut.js";
import { resetBridgeHealth } from "../BridgeHealth.js";
import { getGuildPrefix } from "../GetGuildPrefix.js";
import { CommandHandler } from "../CommandHandler.js";
import { cacheUser } from "../MentionResolver.js";
import { log } from "../Logger.js";
import { waitForPendingMirror, ensureThreadFannedOut } from "../ThreadMirror.js";
import { collectTargets, linkedThreadFamilyEndpoints } from "./targets.js";
import { classifyWebhookMessage, propagateRelayEcho } from "./relay.js";
import { renderForTarget, renderEarlyBridge, countCustomEmojis } from "./render.js";
import { sendToTarget, sendEarlyBridge } from "./send.js";
import { shouldSkipMessageType } from "./UnifiedMessage.js";
import { resolveDiscordReference, resolveFluxerReference } from "./references.js";
import { isFluxerRateLimited } from "../FluxerRateLimit.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { attemptParseBridgedMessage } from "../MessageContentParser.js";
import { pipelineCreate } from "./adapters.js";

export async function handleCreate(umsg, options = {}) {
  if (umsg.guildId == null) return;
  if (shouldSkipMessageType(umsg.platform, umsg.type)) return;
  if (umsg.platform === "fluxer" && umsg.id === umsg.channelId) return;
  if (umsg.platform === "discord" && umsg.id === umsg.channelId && umsg.raw?.channel?.isThread?.()) {
    log("DEBUG", `Create skip discord id=${umsg.id} reason=forumStarter`);
    return;
  }

  if (umsg.platform === "discord" && umsg.type === MessageType.ChatInputCommand && umsg.raw.flags?.has?.("Loading")) {
    log("DEBUG", `Create defer id=${umsg.id} reason=loadingInteraction`);
    setTimeout(async () => {
      try {
        await pipelineCreate(umsg.raw, { instanceId: umsg.instanceId });
      } catch (e) {
        await sendErrorMessage(umsg.raw, umsg.ctx.discordClient, e);
      }
    }, 5000);
    return;
  }

  cacheUser(umsg.raw.author, umsg.platform);

  const guildPrefix = await getGuildPrefix(umsg.guildId);
  if ((umsg.content ?? "").startsWith(guildPrefix)) {
    log("DEBUG", `Create ${umsg.platform} id=${umsg.id} isCommand=${options.execCommands !== false}`);
    if (options.execCommands === false) return;
    await CommandHandler(
      umsg.raw,
      umsg.ctx.discordClient,
      umsg.platform === "fluxer" ? umsg.client : umsg.ctx.defaultFluxerClient
    );
    return;
  }

  if (!umsg.client?.token && !umsg.ctx.discordClient?.token) {
    log("DEBUG", `Create skip ${umsg.platform} id=${umsg.id} reason=noSourceClient`);
    return;
  }

  const thread = umsg.raw?.channel?.isThread?.() ? umsg.raw.channel : null;
  if (thread) {
    await waitForPendingMirror(umsg.platform, umsg.channelId);
    if (!(umsg.platform === "fluxer" && thread.type === 12)) {
      const made = await ensureThreadFannedOut(thread, {
        platform: umsg.platform,
        discordClient: umsg.ctx.discordClient,
        fluxerClient: umsg.client,
        instanceId: umsg.instanceId,
        bridgeMessage: msg => pipelineCreateDynamic(msg, umsg),
      });
      if (made.length > 0) {
        log("DEBUG", `Create fanout thread ${thread.id} count=${made.length}`);
        return;
      }
    }
  }

  let endpoints = await findEndpoints(umsg.platform, umsg.channelId);

  if (endpoints.length === 0 && thread) {
    const pending = await waitForPendingMirror(umsg.platform, umsg.channelId);
    if (pending?.length) {
      endpoints = pending;
      log("DEBUG", `Create ${umsg.platform} id=${umsg.id} resolved pending mirror for thread ${umsg.channelId}`);
    }
  }

  if (endpoints.length === 0) {
    log("DEBUG", `Create skip ${umsg.platform} id=${umsg.id} channelId=${umsg.channelId} reason=noEndpoints`);
    return;
  }

  const echo = classifyWebhookMessage(umsg, endpoints);
  log(
    "DEBUG",
    `Echo classify ${umsg.platform} id=${umsg.id} kind=${echo.kind} webhookId=${umsg.webhookId ?? "null"} authorId=${umsg.author?.id ?? "null"} endpointCount=${endpoints.length} matched=${echo.relayEndpoint?.id ?? "none"} relayRecord=${Boolean(echo.relay)}`
  );
  if (echo.kind === "echo") {
    await propagateRelayEcho(umsg, echo.relayEndpoint, echo.relay, umsg.ctx);
    return;
  }
  if (echo.kind === "foreign") {
    log("DEBUG", `Create skip ${umsg.platform} id=${umsg.id} authorId=${umsg.webhookId ?? umsg.author?.id} reason=webhookEcho`);
    return;
  }

  if (!(await canUserBridge(umsg.platform, umsg.author?.id, umsg.guildId))) {
    const guildName = umsg.guild?.name ?? umsg.guildId;
    await promptOptedOutUserOnFirstMessage(umsg.guildId, umsg.platform, umsg.raw.author, guildName);
    log("DEBUG", `Create skip ${umsg.platform} id=${umsg.id} reason=userOptOut`);
    return;
  }

  const kind = endpoints.some(e => e.kind === "thread") ? "thread" : "channel";

  const parsed = umsg.platform === "discord" ? await attemptParseBridgedMessage(umsg.raw) : null;
  const bridgeContent = parsed?.isBridge || parsed?.isProxy ? parsed : { messageData: { parsedContent: umsg.content } };

  let refMessageId = null;
  let refMessage = null;
  if (umsg.reference && !umsg.reference.forwarded && !umsg.flags.crosspost) {
    refMessageId = umsg.reference.messageId;
  } else if (
    umsg.platform === "discord" &&
    (bridgeContent?.isBridge || bridgeContent?.isProxy) &&
    bridgeContent?.messageData?.messageId
  ) {
    refMessageId = bridgeContent.messageData.messageId;
  }
  if (refMessageId) {
    refMessage =
      umsg.platform === "fluxer"
        ? await resolveFluxerReference(umsg.raw, umsg.client)
        : await resolveDiscordReference(umsg.raw, umsg.client);
    if (!refMessage) refMessage = await resolveRefMessageById(refMessageId, umsg);
    log(
      "DEBUG",
      `Create reply ${umsg.platform} id=${umsg.id} refMessageId=${refMessageId} refMessage=${
        refMessage ? `${refMessage.platform === "fluxer" ? refMessage.id : refMessage.id}` : "none"
      }`
    );
    await waitForMessageMap(
      umsg.platform,
      refMessageId,
      refMessage?.author?.id ?? null,
      refMessage?.createdAt ?? null,
      umsg.guildId
    );
  }

  const linkGroup = newLinkGroup();
  for (const e of endpoints) {
    try {
      await MessageLink.create({
        linkGroup,
        endpointId: e.id,
        messageId: umsg.id,
        replyId: refMessageId,
        authorId: umsg.author?.id ?? null,
      });
    } catch (e) {
      log("DB", `Failed to create source message link message=${umsg.id}`, e);
    }
  }

  const targets = await collectTargets(endpoints, umsg.platform, { kind, excludeChannelId: umsg.channelId });
  let filteredTargets = targets;
  if (kind === "thread") {
    const family = await linkedThreadFamilyEndpoints(umsg.channelId);
    if (family.size > 0) {
      filteredTargets = targets
        .map(entry => ({ ...entry, endpoints: entry.endpoints.filter(e => family.has(e.id)) }))
        .filter(entry => entry.endpoints.length > 0);
    }
  }

  const emojiCount = countCustomEmojis(
    bridgeContent?.messageData?.parsedContent ?? umsg.content ?? "",
    umsg.stickers?.values ? umsg.stickers.size : (umsg.stickers?.length ?? 0)
  );

  let sentAny = false;
  let earlyDone = false;
  const deliveredFlags = new Map();
  for (const entry of filteredTargets) {
    const targetEndpoint = entry.endpoints.find(e => e.webhookId) ?? entry.endpoints[0];
    for (const endpoint of entry.endpoints) {
      const existing = await ensureLink(linkGroup, endpoint.id, umsg.id, refMessageId, umsg.author?.id);
      if (existing && endpoint.id === targetEndpoint.id) deliveredFlags.set(entry.key, false);
    }
  }

  for (const entry of filteredTargets) {
    const targetEndpoint = entry.endpoints.find(e => e.webhookId) ?? entry.endpoints[0];

    if (deliveredFlags.get(entry.key) === false) {
      log("DEBUG", `Create skip target endpoint=${targetEndpoint.id} message=${umsg.id} reason=alreadyLinked`);
      continue;
    }

    const render = await renderForTarget(umsg, targetEndpoint, {
      refMessageId,
      refMessage,
      forwarded: Boolean(umsg.forwardedSnapshot),
      bridgeContent,
      ctx: umsg.ctx,
    });

    if (emojiCount >= 3 && !earlyDone && !isFluxerRateLimited(`webhook:${targetEndpoint.webhookId}`)) {
      const earlyRender = await renderEarlyBridge(umsg, targetEndpoint, {
        forwarded: Boolean(umsg.forwardedSnapshot),
        bridgeContent,
        ctx: umsg.ctx,
        messageReferenceOption: umsg.platform === "fluxer" ? null : (render.messageReferenceOption ?? null),
      });
      const early = await sendEarlyBridge(umsg, targetEndpoint, earlyRender, umsg.ctx);
      if (early?.id) {
        render.editMessageId = early.id;
        render.messageReferenceOption = null;
      }
      earlyDone = true;
    }

    const sent = await sendToTarget(umsg, targetEndpoint, render, umsg.ctx, {
      linkGroup,
      sourceGroupId: options.sourceGroupId ?? null,
      endpoints: entry.endpoints,
    });
    if (sent) sentAny = true;
  }

  if (sentAny) {
    resetBridgeHealth(umsg.guildId);
    scheduleSourceVerification(umsg, umsg.raw.content ?? "");
  }
}

async function resolveRefMessageById(messageId, umsg) {
  try {
    const row = await MessageLink.findOne({ where: { messageId }, include: ["endpoint"] });
    if (!row?.endpoint) return null;
    const ep = row.endpoint;
    if (ep.platform === "fluxer") {
      const client = resolveFluxerClient(ep.instanceId);
      const channel = await client.channels.fetch(ep.channelId);
      return await channel.messages.fetch(row.messageId);
    }
    const channel = await umsg.ctx.discordClient.channels.fetch(ep.channelId);
    return await channel.messages.fetch(row.messageId);
  } catch {
    return null;
  }
}

async function pipelineCreateDynamic(msg, umsg) {
  const { pipelineCreate } = await import("./adapters.js");
  await pipelineCreate(msg, { instanceId: umsg.instanceId });
}

function isSourceMessageGoneError(e) {
  return (
    e?.code === 10008 ||
    e?.code === "MESSAGE_NOT_FOUND" ||
    e?.code === "UNKNOWN_MESSAGE" ||
    e?.status === 404 ||
    e?.statusCode === 404
  );
}

function scheduleSourceVerification(umsg, initialContent) {
  const checkMsg = async () => {
    try {
      const channel = umsg.raw.channel?.fetch ? await umsg.raw.channel.fetch() : umsg.raw.channel;
      if (!channel?.isTextBased?.() && !channel?.messages) return;
      const fetched = await channel.messages.fetch(umsg.id);
      if (fetched.content !== initialContent || fetched.editedAt) {
        const { pipelineEdit } = await import("./adapters.js");
        await pipelineEdit(fetched, { instanceId: umsg.instanceId });
      }
    } catch (e) {
      if (isSourceMessageGoneError(e)) {
        const { pipelineDelete } = await import("./adapters.js");
        await pipelineDelete(umsg.raw, { instanceId: umsg.instanceId });
        return;
      }
      log("DEBUG", `Source message verification failed ${umsg.platform} id=${umsg.id}`, e);
    }
  };
  setTimeout(checkMsg, 1000);
  setTimeout(checkMsg, 2500);
  setTimeout(checkMsg, 5000);
}
