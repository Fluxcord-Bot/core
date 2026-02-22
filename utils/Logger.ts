import Config from "../config";

export function log(type: string, ...msg: any[]) {
  if (!Config.LoggingCategories.includes(type)) return;
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })} ${type}]`,
    ...msg,
  );
}
