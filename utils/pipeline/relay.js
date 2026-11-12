import { MessageLink } from "../../db/index.js";
import { recordRelay, getRelay, ensureLink } from "../Bridging.js";
import { log } from "../Logger.js";
import { collectTargets, channelEndpoints, linkedGroupIds } from "./targets.js";
import { sendToTarget } from "./send.js";
import { renderPlain } from "./render.js";

const MAX_ATTACHMENT_SIZE = 19_999_000;

export { recordRelay, getRelay, MAX_ATTACHMENT_SIZE };

export function classifyWebhookMessage(umsg, endpoints) {
  const relayWebhookId = umsg.platform === "fluxer" ? (umsg.webhookId ?? umsg.author?.id ?? null) : (umsg.webhookId ?? null);
  if (!relayWebhookId) return { kind: "user", relayEndpoint: null, relay: null };

  let relayEndpoint = null;
  let relay = null;
  for (const e of endpoints) {
    if (!e.webhookId || e.webhookId !== relayWebhookId) continue;
    const record = getRelay(e.id, relayWebhookId);
    if (record) {
      relay = record;
      relayEndpoint = e;
      break;
    }
    if (!relayEndpoint) relayEndpoint = e;
  }

  if (relayEndpoint && relay) return { kind: "echo", relayEndpoint, relay };
  if (relayEndpoint) return { kind: "foreign", relayEndpoint, relay: null };
  return { kind: "user", relayEndpoint: null, relay: null };
}

export async function propagateRelayEcho(umsg, relayEndpoint, relay, ctx) {
  const linkGroup = relay.linkGroup;
  const sourceGroupId = relay.sourceGroupId;

  const endpoints = await channelEndpoints(relayEndpoint);
  if (endpoints.length === 0) return;

  const targets = await collectTargets(endpoints, umsg.platform, {
    excludeGroupIds: [...new Set([sourceGroupId, ...(await linkedGroupIds(linkGroup, endpoints))].filter(g => g != null))],
    kind: relayEndpoint.kind,
    excludeChannelId: relayEndpoint.channelId,
  });

  await Promise.allSettled(
    targets.map(async entry => {
      let isNew = false;
      for (const endpoint of entry.endpoints) {
        const existing = await ensureLink(linkGroup, endpoint.id, umsg.id, null, null);
        if (!existing) isNew = true;
      }
      if (!isNew) {
        log("DEBUG", `RelayEcho skip target entry=${entry.key} group=${linkGroup} reason=alreadyLinked`);
        return;
      }

      const sent = await sendToTarget(umsg, entry.endpoints[0], await renderPlain(umsg, entry.endpoints[0]), ctx, {
        linkGroup,
        sourceGroupId,
        endpoints: entry.endpoints,
      });
      if (sent) {
        recordRelay(entry.endpoints[0].id, entry.endpoints[0].webhookId ?? null, linkGroup, sourceGroupId);
      }
    })
  );
}
