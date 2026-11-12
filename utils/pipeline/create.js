import { MessageLink } from "../../db/index.js";
import { findEndpoints, newLinkGroup, ensureLink } from "../Bridging.js";
import { waitForMessageMap } from "../WaitForMessageMap.js";
import { canUserBridge, promptOptedOutUserOnFirstMessage } from "../UserOptOut.js";
import { resetBridgeHealth } from "../BridgeHealth.js";
import { getGuildPrefix } from "../GetGuildPrefix.js";
import { CommandHandler } from "../CommandHandler.js";
import { cacheUser } from "../MentionResolver.js";
import { log } from "../Logger.js";
import { waitForPendingMirror } from "../ThreadMirror.js";
import { collectTargets } from "./targets.js";
import { classifyWebhookMessage, propagateRelayEcho } from "./relay.js";
import { renderForTarget } from "./render.js";
import { sendToTarget } from "./send.js";
import { shouldSkipMessageType } from "./UnifiedMessage.js";
import { resolveDiscordReference, resolveFluxerReference } from "./references.js";
import { attemptParseBridgedMessage } from "../MessageContentParser.js";

export async function handleCreate(umsg, options = {}) {
  if (umsg.guildId == null) return;
  if (shouldSkipMessageType(umsg.platform, umsg.type)) return;
  if (umsg.platform === "fluxer" && umsg.id === umsg.channelId) return;

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

  let endpoints = await findEndpoints(umsg.platform, umsg.channelId);

  if (endpoints.length === 0 && umsg.raw?.channel?.isThread?.()) {
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

  let refMessageId = null;
  let refMessage = null;
  if (umsg.reference && !umsg.reference.forwarded && !umsg.flags.crosspost) {
    refMessageId = umsg.reference.messageId;
  }
  if (refMessageId) {
    refMessage =
      umsg.platform === "fluxer"
        ? await resolveFluxerReference(umsg.raw, umsg.client)
        : await resolveDiscordReference(umsg.raw, umsg.client);
    await waitForMessageMap(
      umsg.platform,
      refMessageId,
      refMessage?.author?.id ?? null,
      refMessage?.createdAt ?? null,
      umsg.guildId
    );
  }

  const bridgeContent =
    umsg.platform === "discord" ? attemptParseBridgedMessage(umsg.raw) : { messageData: { parsedContent: umsg.content } };

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

  let sentAny = false;
  for (const entry of targets) {
    const targetEndpoint = entry.endpoints.find(e => e.webhookId) ?? entry.endpoints[0];

    let delivered = true;
    for (const endpoint of entry.endpoints) {
      const existing = await ensureLink(linkGroup, endpoint.id, umsg.id, refMessageId, umsg.author?.id);
      if (existing && endpoint.id === targetEndpoint.id) delivered = false;
    }
    if (!delivered) {
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

    const sent = await sendToTarget(umsg, targetEndpoint, render, umsg.ctx, {
      linkGroup,
      sourceGroupId: options.sourceGroupId ?? null,
      endpoints: entry.endpoints,
    });
    if (sent) sentAny = true;
  }

  if (sentAny) resetBridgeHealth(umsg.guildId);
}
