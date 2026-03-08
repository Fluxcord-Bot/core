const discordLink = (clientId) =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=3096671994506304&integration_type=0&scope=bot+applications.commands`;
const fluxerLink = (clientId) =>
  `https://web.fluxer.app/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=2260735261797440`;

export function genAuthLink(clientId, fluxer) {
  return fluxer ? discordLink(clientId) : fluxerLink(clientId);
}
