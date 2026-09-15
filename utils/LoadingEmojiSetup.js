import fs from "node:fs";
import Config from "../utils/ConfigHandler.js";
import { log } from "./Logger.js";
import { buildExtHttpUserAgent } from "./UserAgent.js";

/**
 * @param {DiscordClient} discordClient
 * @param {FluxerClient} fluxerClient
 */
export async function ensureLoadingEmojis(discordClient, fluxerClient) {
  const jsonPath = Config.DataFolderPath + "/fluxcord.json";
  const current = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

  if (current.fluxerLoadingEmoji && current.discordLoadingEmoji) {
    return;
  }

  log("META", "Setting up loading emoji...");

  const loadingRes = await fetch(
    Config.InternalAssetsPrefixUrl + "/loading.gif",
    {
      headers: {
        "User-Agent": buildExtHttpUserAgent(),
      },
    },
  );
  if (!loadingRes.ok) {
    throw new Error(`Failed to fetch loading.gif: ${loadingRes.status}`);
  }
  const loadingBuf = Buffer.from(await loadingRes.arrayBuffer());

  if (!current.fluxerLoadingEmoji) {
    const fluxerGuild = await fluxerClient.guilds.fetch(
      Config.FluxerTempEmojiGuildId,
    );
    try {
      await fluxerGuild?.createEmojisBulk([
        {
          // @ts-ignore
          image: loadingBuf.toString("base64"),
          name: "loading",
        },
      ]);
    } catch {}

    const fluxerLoadingEmoji = await fluxerClient.resolveEmoji(
      ":loading:",
      Config.FluxerTempEmojiGuildId,
    );
    if (fluxerLoadingEmoji) {
      current.fluxerLoadingEmoji = fluxerLoadingEmoji;
    }
  }

  if (!current.discordLoadingEmoji) {
    let discordLoadingEmoji;
    try {
      discordLoadingEmoji = await discordClient.application?.emojis.create({
        attachment: loadingBuf,
        name: "loading",
      });
    } catch {}

    if (!discordLoadingEmoji) {
      const existing = await discordClient.application?.emojis.fetch();
      discordLoadingEmoji ??= existing?.find((e) => e.name === "loading");
    }

    if (discordLoadingEmoji?.id) {
      current.discordLoadingEmoji = discordLoadingEmoji.id;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(current));
  log("META", "Loading emoji setup done!");
}
