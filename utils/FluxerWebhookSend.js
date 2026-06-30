/**
 * @typedef {Object} FileOptions
 * @property {{name: string, url: string}[] | undefined} files
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
  const formData = new FormData();
  const { files, ...jsonPayload } = params;

  if (files) {
    for (let i = 0; i < files.length; i++) {
      try {
        const file = files[i];
        const res = await fetch(file.url);
        const blob = await res.blob();

        formData.append(`files[${i}]`, blob, file.name);

        attachments.push({
          id: i,
          filename: file.name,
        });
      } catch (e) {
        log("FLUXER", `Failed to fetch: ${e}`);
      }
    }
  }

  jsonPayload.attachments = attachments;
  formData.append("payload_json", JSON.stringify(jsonPayload));

  const result = await fluxerClient.rest.post(
    `/webhooks/${webhookId}/${webhookToken}?wait=true`,
    {
      body: formData,
      auth: false,
    },
  );

  return result;
}
