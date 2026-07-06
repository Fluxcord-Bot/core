/**
 * @typedef {Object} FileOptions
 * @property {{name: string, url: string, flags?: number}[] | undefined} files
 */

import { log } from "./Logger.js";

/**
 * @param {string} webhookId
 * @param {string} webhookToken
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {import("@fluxerjs/core").WebhookSendOptions & FileOptions} params
 */
export async function sendFluxerWebhook(
  webhookId,
  webhookToken,
  fluxerClient,
  params,
) {
  const attachments = [];
  const resolvedFiles = [];
  const { files, ...jsonPayload } = params;

  if (files) {
    for (let i = 0; i < files.length; i++) {
      try {
        const file = files[i];
        const res = await fetch(file.url);
        const data = await res.arrayBuffer();

        resolvedFiles.push({
          name: file.name,
          filename: file.name,
          data,
        });

        attachments.push({
          id: i,
          filename: file.name,
          flags: file.flags,
          description: file.description,
        });
      } catch (e) {
        log("FLUXER", `Failed to fetch: ${e}`);
      }
    }
  }

  jsonPayload.attachments = attachments;

  const result = await fluxerClient.rest.post(
    `/webhooks/${webhookId}/${webhookToken}?wait=true`,
    {
      body: jsonPayload,
      files: resolvedFiles,
      auth: false,
    },
  );

  return result;
}
