/**
 * @typedef {Object} FileOptions
 * @property {{name: string, url: string, flags?: number}[] | undefined} files
 * @property {string} [threadId]
 * @property {string} [thread_name]
 * @property {string[]} [applied_tags]
 */

import { log } from "./Logger.js";
import { withFluxerRateLimit } from "./FluxerRateLimit.js";

function toAttachmentPayload(file, id) {
  const attachment = {
    id,
    filename: file.name,
  };

  if (file.flags !== undefined) attachment.flags = file.flags;
  if (file.description != null) attachment.description = file.description;

  return attachment;
}

/**
 * @param {string} webhookId
 * @param {string} webhookToken
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {any} params
 * @returns {Promise<any>}
 */
export async function sendFluxerWebhook(webhookId, webhookToken, fluxerClient, params) {
  const resolvedFiles = [];
  const { files, threadId, thread_name, applied_tags, channelId, ...jsonPayload } = params;

  log("DEBUG", `[FluxerWebhookSend] Preparing to send webhook with ${files?.length ?? 0} files.`);

  if (files) {
    for (let i = 0; i < files.length; i++) {
      try {
        const file = files[i];
        let data = file.data ?? file.attachment;
        let contentType = file.contentType;

        if (!data) {
          if (!file.url) {
            log("DEBUG", `File at index ${i} has no data or URL, skipping.`);
            continue;
          }

          const res = await fetch(file.url);
          if (!res.ok) {
            log("DISCORD", `Failed to download attachment ${file.name} from ${file.url}: ${res.status} ${res.statusText}`);
            continue;
          }
          data = await res.arrayBuffer();
          contentType ??= res.headers.get("content-type")?.split(";")[0] || undefined;
        }

        resolvedFiles.push({ file, contentType, data });
      } catch (e) {
        log("FLUXER", `Failed to fetch: ${e}`);
      }
    }
  }

  if (thread_name !== undefined) jsonPayload.thread_name = thread_name;
  if (applied_tags !== undefined) jsonPayload.applied_tags = applied_tags;

  const path = `/webhooks/${webhookId}/${webhookToken}?wait=true${threadId ? `&thread_id=${threadId}` : ""}`;

  let cloudAttachments;
  if (channelId && resolvedFiles.length > 0) {
    try {
      const channel = await fluxerClient.channels.fetch(channelId);
      const uploaded = await channel.uploadAttachmentsForSend(
        resolvedFiles.map((e, i) => ({
          id: i,
          filename: e.file.name,
          data: e.data,
          contentType: e.contentType ?? "application/octet-stream",
        }))
      );
      const slots = new Map(uploaded.map(u => [u.id, u]));
      cloudAttachments = resolvedFiles.map((e, i) => {
        const slot = slots.get(i);
        if (!slot) throw new Error(`Fluxer returned no upload slot for ${e.file.name}`);
        return { ...toAttachmentPayload(e.file, i), ...slot };
      });
    } catch (e) {
      log("FLUXER", `Cloud upload failed for webhook ${webhookId}, sending files inline`, e);
    }
  }

  jsonPayload.attachments = cloudAttachments ?? resolvedFiles.map((e, i) => toAttachmentPayload(e.file, i));

  return await withFluxerRateLimit(
    () =>
      fluxerClient.rest.post(path, {
        body: jsonPayload,
        ...(cloudAttachments ? {} : { files: resolvedFiles.map(e => ({ name: e.file.name, filename: e.file.name, data: e.data })) }),
        auth: false,
      }),
    `webhook:${webhookId}`
  );
}

/**
 * @param {string} webhookId
 * @param {string} webhookToken
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {string} messageId
 * @param {any} params
 * @param {{ threadId?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function editFluxerWebhook(webhookId, webhookToken, fluxerClient, messageId, params, opts = {}) {
  const { files, threadId, ...jsonPayload } = params;
  let path = `/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;
  if (opts.threadId) path = `${path}?thread_id=${opts.threadId}`;

  return await withFluxerRateLimit(
    () =>
      fluxerClient.rest.patch(path, {
        body: jsonPayload,
        auth: false,
      }),
    `webhook:${webhookId}`
  );
}
