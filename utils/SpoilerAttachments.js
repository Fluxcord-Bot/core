const SPOILER_ATTACHMENT_FLAG = 1 << 3;
const DISCORD_SPOILER_PREFIX = "SPOILER_";

export function isDiscordSpoilerAttachment(attachment) {
  const numericFlags =
    typeof attachment?.flags === "number"
      ? attachment.flags
      : typeof attachment?.flags?.bitfield === "number"
        ? attachment.flags.bitfield
        : 0;
  return Boolean(
    attachment?.spoiler ||
      (numericFlags & SPOILER_ATTACHMENT_FLAG) !== 0 ||
      attachment?.name?.startsWith(DISCORD_SPOILER_PREFIX) ||
      attachment?.filename?.startsWith(DISCORD_SPOILER_PREFIX),
  );
}

export function isFluxerSpoilerAttachment(attachment) {
  return Boolean((attachment?.flags ?? 0) & SPOILER_ATTACHMENT_FLAG);
}

export function toDiscordSpoilerFilename(filename, spoiler) {
  if (!filename) return filename;
  const cleanName = filename.startsWith(DISCORD_SPOILER_PREFIX)
    ? filename.slice(DISCORD_SPOILER_PREFIX.length)
    : filename;
  return spoiler ? `${DISCORD_SPOILER_PREFIX}${cleanName}` : cleanName;
}

export { SPOILER_ATTACHMENT_FLAG };
