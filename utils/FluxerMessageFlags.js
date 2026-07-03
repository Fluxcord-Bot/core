import { MessageAttachmentFlags } from "@fluxerjs/core";

export function fluxerMessageFlags({
  spoiler = false,
  explicit = false,
  animated = false,
} = {}) {
  let flags = 0;
  if (spoiler) flags |= MessageAttachmentFlags.IS_SPOILER;
  if (explicit) flags |= MessageAttachmentFlags.CONTAINS_EXPLICIT_MEDIA;
  if (animated) flags |= MessageAttachmentFlags.IS_ANIMATED;
  return flags;
}
