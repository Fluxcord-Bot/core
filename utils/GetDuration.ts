export function getDuration(start: Date, end: Date) {
  let diffMs = end.getTime() - start.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  diffMs -= days * 1000 * 60 * 60 * 24;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  diffMs -= hours * 1000 * 60 * 60;
  const minutes = Math.floor(diffMs / (1000 * 60));
  diffMs -= minutes * 1000 * 60;
  const seconds = Math.floor(diffMs / 1000);
  return (
    (days > 0 ? days + " days, " : "") +
    (hours > 0 ? hours + " hours, " : "") +
    (minutes > 0 ? minutes + " minutes, " : "") +
    (seconds + " seconds")
  ).trim();
}
