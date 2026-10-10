/**
 * @typedef {Object} FileOptions
 * @property {{name: string, url: string, flags?: number}[] | undefined} files
 * @property {string} [threadId]
 * @property {string} [thread_name]
 * @property {string[]} [applied_tags]
 */

import { log } from "./Logger.js";

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
 * @param {import("@fluxerjs/core").WebhookSendOptions & FileOptions} params
 */
export async function sendFluxerWebhook(webhookId, webhookToken, fluxerClient, params) {
  const attachments = [];
  const resolvedFiles = [];
  const { files, threadId, thread_name, applied_tags, ...jsonPayload } = params;

  log("DEBUG", `[FluxerWebhookSend] Preparing to send webhook with ${files?.length ?? 0} files.`);

  if (files) {
    for (let i = 0; i < files.length; i++) {
      try {
        const file = files[i];
        let data = file.data ?? file.attachment;

        if (!data) {
          if (!file.url) {
            log("DEBUG", `File at index ${i} has no data or URL, skipping.`);
            continue;
          }

          const res = await fetch(file.url);
          data = await res.arrayBuffer();
        }

        resolvedFiles.push({
          name: file.name,
          filename: file.name,
          data,
        });

        attachments.push(toAttachmentPayload(file, i));
      } catch (e) {
        log("FLUXER", `Failed to fetch: ${e}`);
      }
    }
  }

  jsonPayload.attachments = attachments;

  if (thread_name !== undefined) jsonPayload.thread_name = thread_name;
  if (applied_tags !== undefined) jsonPayload.applied_tags = applied_tags;

  const query = threadId ? `?wait=true&thread_id=${threadId}` : "?wait=true";

  return await fluxerClient.rest.post(`/webhooks/${webhookId}/${webhookToken}${query}`, {
    body: jsonPayload,
    files: resolvedFiles,
    auth: false,
  });
}
