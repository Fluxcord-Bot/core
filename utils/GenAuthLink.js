import { getFluxerWebappUrl } from "./GetFluxerUrls.js";

const discordLink = (clientId) =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=3096671994506304&integration_type=0&scope=bot+applications.commands`;
const fluxerLink = async (clientId) => {
  const webappUrl = await getFluxerWebappUrl();
  return `${webappUrl}/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=2260735261797440`;
};

export async function genAuthLink(clientId, fluxer) {
  return !fluxer ? discordLink(clientId) : fluxerLink(clientId);
}

export function renderBox(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const top = `┏━${"━".repeat(width)}━┓`;
  const bottom = `┗━${"━".repeat(width)}━┛`;
  const middle = lines.map((l) => `┃ ${l.padEnd(width)} ┃`);
  [top, ...middle, bottom].forEach((x) => console.log(x));
}
