import { Guild as FluxerGuild } from "@fluxerjs/core";

const idCache = new Map();
const usernameCache = new Map();

function platformOf(guild) {
  return guild instanceof FluxerGuild ? "fluxer" : "discord";
}

function hiddenDiscriminatorFor(platform) {
  return platform === "fluxer" ? "0000" : "0";
}

function tagOf(user, platform) {
  const hidden = hiddenDiscriminatorFor(platform);
  const disc = String(user.discriminator ?? hidden);
  const name = user.username.toLowerCase();
  return disc === hidden ? name : `${name}#${disc}`;
}

function trimCache() {
  if (idCache.size <= 5000) return;
  const oldestId = idCache.keys().next().value;
  const oldest = idCache.get(oldestId);
  usernameCache.delete(tagOf(oldest, oldest.platform));
  idCache.delete(oldestId);
}

export function cacheUser(user, platform = "discord") {
  if (!user?.id) return;
  const old = idCache.get(user.id);
  if (old) usernameCache.delete(tagOf(old, old.platform));
  idCache.set(user.id, {
    username: user.username,
    discriminator: String(user.discriminator ?? hiddenDiscriminatorFor(platform)),
    platform,
  });
  usernameCache.set(tagOf(user, platform), user.id);
  trimCache();
}

async function fetchMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function searchMembers(guild, username) {
  try {
    return await guild.members.search({ query: username, limit: 5 });
  } catch {
    return null;
  }
}

function hitToUser(hit) {
  if (hit?.member?.user) return { user: hit.member.user, member: hit.member };
  if (hit?.user) return { user: hit.user, member: hit };
  if (hit?.username) return { user: hit, member: null };
  return null;
}

export async function resolveUsername(guild, username, discriminator) {
  const platform = platformOf(guild);
  const name = username.toLowerCase();
  const key = tagOf({ username, discriminator }, platform);

  const cachedId = usernameCache.get(key);
  if (cachedId) {
    const member = await fetchMember(guild, cachedId);
    if (member) return member;
    usernameCache.delete(key);
  }

  const raw = await searchMembers(guild, username);
  if (!raw) return null;
  const hits = raw.members ?? [...raw.values()];

  for (const hit of hits) {
    const parsed = hitToUser(hit);
    if (!parsed) continue;
    if (
      tagOf(parsed.user, platform) !== key &&
      parsed.user.username.toLowerCase() !== name
    )
      continue;
    if (parsed.member) {
      cacheUser(parsed.user, platform);
      return parsed.member;
    }
    const full = await fetchMember(
      guild,
      parsed.user.userId ?? parsed.user.id,
    );
    if (!full) continue;
    cacheUser(full.user ?? full, platform);
    return full;
  }

  return null;
}

export async function resolveId(guild, userId) {
  const member = await fetchMember(guild, userId);
  if (member) cacheUser(member.user ?? member, platformOf(guild));
  return member;
}

export async function resolveMentions(guild, content) {
  if (!content) return content;
  const platform = platformOf(guild);
  const mentionRegex = /(?<![\w.])@([a-z0-9_.]{2,32})(?:#(\d{4}))?\b/gi;
  const skipNames = ["everyone", "here"];
  const wanted = new Map();
  for (const [, username, discriminator] of content.matchAll(mentionRegex)) {
    if (skipNames.includes(username.toLowerCase())) continue;
    const key = tagOf({ username, discriminator }, platform);
    if (!wanted.has(key)) wanted.set(key, { username, discriminator });
  }
  if (wanted.size === 0) return content;

  const ids = await Promise.all(
    [...wanted].map(async ([key, { username, discriminator }]) => {
      const member = await resolveUsername(guild, username, discriminator);
      return [key, (member?.user ?? member)?.id];
    }),
  );
  const resolved = new Map(ids.filter(([, id]) => id));
  if (resolved.size === 0) return content;

  return content.replace(mentionRegex, (full, username, discriminator) => {
    if (skipNames.includes(username.toLowerCase())) return full;
    const id = resolved.get(tagOf({ username, discriminator }, platform));
    return id ? `<@${id}>` : full;
  });
}

export async function reverseMentions(guild, content) {
  if (!content) return content;
  const platform = platformOf(guild);
  const snowflakeRegex = /<@!?(\d{17,20})>/g;
  const ids = [
    ...new Set([...content.matchAll(snowflakeRegex)].map((m) => m[1])),
  ];
  if (ids.length === 0) return content;

  const users = await Promise.all(
    ids.map(async (id) => {
      const member = await resolveId(guild, id);
      return [id, member ? (member.user ?? member) : null];
    }),
  );
  const resolved = new Map(users.filter(([, user]) => user));
  if (resolved.size === 0) return content;

  return content.replace(snowflakeRegex, (full, id) => {
    const user = resolved.get(id);
    return user ? `@${tagOf(user, platform)}` : full;
  });
}
