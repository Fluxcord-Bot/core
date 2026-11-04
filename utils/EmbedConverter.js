import { EmbedBuilder as FluxerEmbedBuilder } from "@fluxerjs/core";
import { EmbedBuilder as DiscordEmbedBuilder } from "discord.js";
import { parseDiscordEmojiToFluxer, parseFluxerEmojiToDiscord } from "./EmojiStickerParser.js";

const EMBED_URL_PATTERN = /https?:\/\/[^\s<>()]+/g;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function looksLikeSameLink(a, b) {
  if (!a || !b) return false;
  if (a.href === b.href) return true;

  const aPath = a.pathname.replace(/\/+$/, "");
  return aPath !== "" && aPath === b.pathname.replace(/\/+$/, "");
}

export function isPlatformPreviewEmbed(embed, content = "") {
  if (embed.type && embed.type !== "rich") return true;
  if (embed.provider || embed.video || embed.audio || embed.html || (embed.children?.length ?? 0) > 0) return true;

  const embedUrl = parseUrl(embed.url);
  if (!embedUrl) return false;

  for (const match of (content ?? "").matchAll(EMBED_URL_PATTERN)) {
    if (looksLikeSameLink(embedUrl, parseUrl(match[0].replace(/[.,;:!?]+$/, "")))) return true;
  }
  return false;
}

/**
 * @param {DiscordEmbed} embed
 * @param {FluxerClient} fluxerClient
 * @returns {Promise<FluxerEmbedBuilder>}
 */
export async function discordEmbedToFluxer(embed, fluxerClient) {
  let outEmbed = new FluxerEmbedBuilder()
    .setTitle(embed.title)
    .setURL(embed.url)
    .setColor(embed.color)
    .setTimestamp(embed.timestamp ? Date.parse(embed.timestamp) : null)
    .addFields(
      ...(await Promise.all(
        embed.fields.map(async x => ({
          name: x.name,
          value: (await parseDiscordEmojiToFluxer(x.value, fluxerClient)) ?? "\u200b",
          inline: x.inline,
        }))
      ))
    );

  if (embed.description) {
    outEmbed = outEmbed.setDescription(await parseDiscordEmojiToFluxer(embed.description, fluxerClient));
  }

  if (embed.author)
    outEmbed = outEmbed.setAuthor({
      name: embed.author.name,
      iconURL: embed.author.iconURL,
      url: embed.author.url,
    });

  if (embed.footer)
    outEmbed = outEmbed.setFooter({
      text: embed.footer.text,
      iconURL: embed.footer.iconURL,
    });

  if (embed.image)
    outEmbed = outEmbed.setImage({
      url: embed.image.url,
      width: embed.image.width,
      height: embed.image.height,
    });

  if (embed.thumbnail)
    outEmbed = outEmbed.setThumbnail({
      url: embed.thumbnail.url,
      width: embed.thumbnail.width,
      height: embed.thumbnail.height,
    });

  return outEmbed;
}

/**
 * @param {Message} message
 * @param {DiscordClient} discordClient
 * @returns {Promise<DiscordEmbedBuilder[] | undefined>}
 */
export async function fluxerEmbedToDiscord(message, discordClient) {
  const content = message.content ?? "";
  const embeds = (message.embeds ?? []).filter(embed => !isPlatformPreviewEmbed(embed, content));

  if (!embeds) return undefined;

  const embedsOut = await Promise.all(
    embeds.map(async embed => {
      let outEmbed = new DiscordEmbedBuilder()
        .setTitle(embed.title ?? null)
        .setURL(embed.url ?? null)
        .setColor(embed.color ?? null)
        .setTimestamp(embed.timestamp ? Date.parse(embed.timestamp) : null)
        .setDescription(await parseFluxerEmojiToDiscord(embed.description ?? null, discordClient));

      if (embed.fields) {
        outEmbed = outEmbed.addFields(
          ...(await Promise.all(
            embed.fields.map(async x => ({
              name: x.name,
              value: (await parseFluxerEmojiToDiscord(x.value, discordClient)) ?? "\u200b",
              inline: x.inline,
            }))
          ))
        );
      }

      if (embed.author)
        outEmbed = outEmbed.setAuthor({
          name: embed.author.name ?? "",
          iconURL: embed.author.iconUrl,
          url: embed.author.url,
        });

      if (embed.footer)
        outEmbed = outEmbed.setFooter({
          text: embed.footer.text,
          iconURL: embed.footer.iconUrl,
        });

      if (embed.image) outEmbed = outEmbed.setImage(embed.image.url);

      if (embed.thumbnail) outEmbed = outEmbed.setThumbnail(embed.thumbnail.url);

      return outEmbed;
    })
  );

  return embedsOut;
}
