export async function resolveDiscordReference(message, client) {
  const reference = message.reference;
  if (!reference?.messageId || reference.type === 1) return null;

  if (reference.resolved && !reference.resolved.partial) return reference.resolved;

  try {
    const channel =
      reference.channelId && reference.channelId !== message.channelId
        ? await client.channels.fetch(reference.channelId)
        : message.channel;

    if (channel?.isTextBased?.() && channel.messages) {
      return await channel.messages.fetch(reference.messageId);
    }
  } catch {}

  return null;
}

export async function resolveFluxerReference(message, client) {
  if (message.referencedMessage) return message.referencedMessage;
  const reference = message.messageReference;
  if (!reference?.messageId || reference.type === 1) return null;
  try {
    const channel =
      reference.channelId && reference.channelId !== message.channelId
        ? await client.channels.fetch(reference.channelId)
        : message.channel;
    if (channel?.messages) {
      return await channel.messages.fetch(reference.messageId);
    }
  } catch {}
  return null;
}
