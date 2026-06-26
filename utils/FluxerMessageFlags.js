export function fluxerMessageFlags({
  spoiler = false,
  explicit = false,
  animated = false,
} = {}) {
  let flags = 0;
  if (spoiler) flags |= IS_SPOILER;
  if (explicit) flags |= CONTAINS_EXPLICIT_MEDIA;
  if (animated) flags |= IS_ANIMATED;
  return flags;
}
