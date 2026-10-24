import { readFileSync } from "fs";

export default function getCommitHash() {
  try {
    return readFileSync(new URL("../.commit", import.meta.url), "utf8").trim();
  } catch {
    return "unknown";
  }
}
