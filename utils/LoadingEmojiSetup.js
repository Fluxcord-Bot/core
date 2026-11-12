import fs from "node:fs";
import Config, { DiscordEnabled } from "../utils/ConfigHandler.js";
import { fluxerConfigOfClient } from "./PerInstance.js";
import { fluxerClients } from "./FluxerClients.js";
import { log } from "./Logger.js";
import { buildExtHttpUserAgent } from "./UserAgent.js";

/**
 * @param {DiscordClient} discordClient
 * @param {FluxerClient} fluxerClient
 */
export async function ensureLoadingEmojis(discordClient, fluxerClient) {
  const jsonPath = Config.DataFolderPath + "/fluxcord.json";
  const current = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

  current.fluxerLoadingEmojis ??= {};
  if (typeof current.fluxerLoadingEmoji === "string" && !current.fluxerLoadingEmojis.default) {
    current.fluxerLoadingEmojis.default = current.fluxerLoadingEmoji;
  }

  const missingFluxer = [...fluxerClients.keys()].some(id => !current.fluxerLoadingEmojis[id]);
  if (!missingFluxer && (current.discordLoadingEmoji || !DiscordEnabled)) {
    return;
  }

  log("META", "Setting up loading emoji...");

  const loadingRes = await fetch(Config.InternalAssetsPrefixUrl + "/loading.gif", {
    headers: {
      "User-Agent": buildExtHttpUserAgent(),
    },
  });
  if (!loadingRes.ok) {
    throw new Error(`Failed to fetch loading.gif: ${loadingRes.status}`);
  }
  const loadingBuf = Buffer.from(await loadingRes.arrayBuffer());

  for (const [instanceId, client] of fluxerClients) {
    if (current.fluxerLoadingEmojis[instanceId]) continue;
    const instCfg = fluxerConfigOfClient(client);
    const tempGuildId = instCfg?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId;
    const fluxerGuild = await client.guilds.fetch(tempGuildId);
    try {
      await fluxerGuild?.createEmojisBulk([
        {
          // @ts-ignore
          image: loadingBuf.toString("base64"),
          name: "loading",
        },
      ]);
    } catch {}

    const fluxerLoadingEmoji = await client.resolveEmoji(":loading:", tempGuildId);
    if (fluxerLoadingEmoji) {
      current.fluxerLoadingEmojis[instanceId] = fluxerLoadingEmoji;
    }
  }

  if (DiscordEnabled && !current.discordLoadingEmoji) {
    let discordLoadingEmoji;
    try {
      discordLoadingEmoji = await discordClient.application?.emojis.create({
        attachment: loadingBuf,
        name: "loading",
      });
    } catch {}

    if (!discordLoadingEmoji) {
      const existing = await discordClient.application?.emojis.fetch();
      discordLoadingEmoji ??= existing?.find(e => e.name === "loading");
    }

    if (discordLoadingEmoji?.id) {
      current.discordLoadingEmoji = discordLoadingEmoji.id;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(current));
  log("META", "Loading emoji setup done!");
}
