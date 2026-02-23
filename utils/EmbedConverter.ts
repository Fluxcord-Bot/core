import {
  EmbedBuilder as FluxerEmbedBuilder,
  Client as FluxerClient,
  Message,
} from "@fluxerjs/core";
import {
  Embed as DiscordEmbed,
  EmbedBuilder as DiscordEmbedBuilder,
  Client as DiscordClient,
} from "discord.js";
import {
  parseDiscordEmojiToFluxer,
  parseFluxerEmojiToDiscord,
} from "./EmojiStickerParser";

export async function discordEmbedToFluxer(
  embed: DiscordEmbed,
  fluxerClient: FluxerClient,
): Promise<FluxerEmbedBuilder> {
  let outEmbed = new FluxerEmbedBuilder()
    .setTitle(embed.title)
    .setURL(embed.url)
    .setColor(embed.color)
    .setTimestamp(embed.timestamp ? Date.parse(embed.timestamp) : null)
    .setDescription(
      await parseDiscordEmojiToFluxer(embed.description, fluxerClient),
    )
    .addFields(
      ...(await Promise.all(
        embed.fields.map(async (x) => ({
          name: x.name,
          value: (await parseDiscordEmojiToFluxer(x.value, fluxerClient)) ?? "",
          inline: x.inline,
        })),
      )),
    );

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

export async function fluxerEmbedToDiscord(
  message: Message,
  discordClient: DiscordClient,
): Promise<DiscordEmbedBuilder[]> {
  const embeds = message.embeds;

  const embedsOut = await Promise.all(
    embeds.map(async (embed) => {
      let outEmbed = new DiscordEmbedBuilder()
        .setTitle(embed.title ?? null)
        .setURL(embed.url ?? null)
        .setColor(embed.color ?? null)
        .setTimestamp(embed.timestamp ? Date.parse(embed.timestamp) : null)
        .setDescription(
          await parseFluxerEmojiToDiscord(
            embed.description ?? "",
            discordClient,
          ),
        );

      if (embed.fields) {
        outEmbed = outEmbed.addFields(
          ...(await Promise.all(
            embed.fields.map(async (x: any) => ({
              name: x.name,
              value:
                (await parseFluxerEmojiToDiscord(x.value, discordClient)) ?? "",
              inline: x.inline,
            })),
          )),
        );
      }

      if (embed.author)
        outEmbed = outEmbed.setAuthor({
          name: embed.author.name ?? "",
          iconURL: embed.author.icon_url,
          url: embed.author.url,
        });

      if (embed.footer)
        outEmbed = outEmbed.setFooter({
          text: embed.footer.text,
          iconURL: embed.footer.icon_url,
        });

      if (embed.image) outEmbed = outEmbed.setImage(embed.image.url);

      if (embed.thumbnail)
        outEmbed = outEmbed.setThumbnail(embed.thumbnail.url);

      return outEmbed;
    }),
  );

  return embedsOut;
}
