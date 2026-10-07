const silentFlags = ["silent", "quiet", "-s", "--silent"];

export function hasSilentFlag(params) {
  return params.some(x => silentFlags.includes(x.toLowerCase()));
}

export function stripSilentFlag(params) {
  return params.filter(x => !silentFlags.includes(x.toLowerCase()));
}
