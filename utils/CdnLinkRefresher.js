import { log } from "./Logger.js";

const discordCdnAttachmentUrl = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/\d+\/[^\s<>()]+/g;

function staleDiscordCdnLink(url) {
  try {
    const ex = Number.parseInt(new URL(url).searchParams.get("ex") ?? "", 16);
    return !Number.isFinite(ex) || ex * 1000 <= Date.now() + 300000;
  } catch {
    return true;
  }
}

export async function refreshDiscordCdnLinks(content, client, messageId) {
  if (!content?.match) return content;
  const urls = [...new Set(content.match(discordCdnAttachmentUrl) ?? [])].filter(staleDiscordCdnLink);
  if (urls.length === 0) return content;

  let result = content;
  for (let i = 0; i < urls.length; i += 50) {
    try {
      const { refreshed_urls } = await client.rest.post("/attachments/refresh-urls", {
        body: { attachment_urls: urls.slice(i, i + 50) },
      });
      for (const { original, refreshed } of refreshed_urls ?? []) {
        if (original && refreshed)
          result = result.replaceAll(original, refreshed.replace("://media.discordapp.net/", "://cdn.discordapp.com/"));
      }
    } catch (e) {
      log("DISCORD", `Failed to refresh Discord CDN attachment links for message ${messageId}`, e);
    }
  }

  return result;
}
