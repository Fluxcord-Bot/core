import { execSync } from "child_process";

export default function getCommitHash() {
  return execSync("git rev-parse --short HEAD").toString().trim();
}
