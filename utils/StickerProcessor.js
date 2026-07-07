import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { log } from "./Logger.js";

const execFileAsync = promisify(execFile);

// Credit for this idea goes to thororen & equicord for their work on MoreStickers & normalizing media to appear as normal sticker size. 
// https://github.com/Equicord/Equicord/commits/main/src/equicordplugins/moreStickers

const VF_STATIC =
  "scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x00000000";

const VF_ANIMATED =
  "scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x00000000,split[s0][s1];[s0]palettegen=stats_mode=single:transparency_color=000000[p];[s1][p]paletteuse=new=1:alpha_threshold=10";

export async function processSticker(url, { animated = false, name = "sticker" } = {}) {
  log("DEBUG", `start: url=${url} animated=${animated} name=${name}`);

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    log("DEBUG", `fetch failed: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    log("DEBUG", `fetch returned HTTP ${res.status} for ${url}`);
    return null;
  }

  const rawBuffer = Buffer.from(await res.arrayBuffer());
  log("DEBUG", `fetched ${rawBuffer.byteLength} bytes`);

  const id = randomBytes(6).toString("hex");
  const inputPath = join(tmpdir(), `fc_sticker_${id}_in`);
  const ext = animated ? "gif" : "png";
  const outputPath = join(tmpdir(), `fc_sticker_${id}_out.${ext}`);

  try {
    await writeFile(inputPath, rawBuffer);
    const args = animated
      ? ["-y", "-i", inputPath, "-filter_complex", VF_ANIMATED, outputPath]
      : ["-y", "-i", inputPath, "-vf", VF_STATIC, "-pix_fmt", "rgba", "-frames:v", "1", outputPath];
    log("DEBUG", `ffmpeg args: ${args.join(" ")}`);
    const { stderr } = await execFileAsync("ffmpeg", args, { encoding: "utf8" });
    if (stderr) log("DEBUG", `ffmpeg stderr: ${stderr.slice(-500)}`);
    const outBuf = await readFile(outputPath);
    log("DEBUG", `output ${outBuf.byteLength} bytes → ${name}.${ext}`);
    return { buffer: outBuf, filename: `${name}.${ext}` };
  } catch (e) {
    log("DEBUG", `ffmpeg error: ${e.message}`);
    if (e.stderr) log("DEBUG", `ffmpeg stderr: ${String(e.stderr).slice(-800)}`);
    return null;
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => { }),
      unlink(outputPath).catch(() => { }),
    ]);
  }
}
