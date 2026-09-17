import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { log } from "./Logger.js"

const execFileAsync = promisify(execFile);

// Magic param strings came from Thororen & Equicord team (MoreStickers & Fake Nitros plugin)
// https://github.com/Equicord/Equicord/commits/main/src/equicordplugins/moreStickers
// I suck at ffmpeg so awesome work. Especially the animated one. 

const STATIC_PARAMS =
    "scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x00000000"

const ANIMATED_PARAMS =
    "scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x00000000,split[s0][s1];[s0]palettegen=stats_mode=single:transparency_color=000000[p];[s1][p]paletteuse=new=1:alpha_threshold=10";

export async function processSticker(url, { animated = false, name = "sticker" } = {}) {
    let res = null;
    try {
        res = await fetch(url);
    } catch (e) {
        log("DEBUG", `StickerProcessor: sticker fetch failed, ${e.message}`)
        return null;
    }

    if (!res.ok) {
        log("DEBUG", `StickerProcessor: HTTP bad, status ${res.status} for ${url}`)
        return null;
    }

    const rawBuffer = Buffer.from(await res.arrayBuffer());
    const id = randomBytes(6).toString("hex");

    let ext
    if (animated) {
        ext = "gif";
    } else {
        ext = "png";
    }

    const inputPath = join(tmpdir(), `fc_sticker_${id}_in.${ext}`);
    const outputPath = join(tmpdir(), `fc_sticker_${id}_out.${ext}`);

    try {
        await writeFile(inputPath, rawBuffer);
        let args
        if (animated) {
            args = ["-y", "-i", inputPath, "-filter_complex", ANIMATED_PARAMS, outputPath];
        } else {
            args = ["-y", "-i", inputPath, "-vf", STATIC_PARAMS, "-pix_fmt", "rgba", "-frames:v", "1", outputPath];
        }

        return new Promise((resolve) => {
            const ffmpeg = spawn("ffmpeg", args);
            const outChunks = [];
            let errorLog = "";

            ffmpeg.stdout.on("data", (chunk) => {
                outChunks.push(chunk);
            });

            ffmpeg.stderr.on("data", (chunk) => {
                errorLog += chunk.toString();
            });



        })

        const { stderr } = await execFileAsync("ffmpeg", args, { encoding: "utf8" });

        const out = await readFile(outputPath);
        return { buffer: out, filename: `${name}.${ext}` };
    } catch (e) {
        log("DEBUG", `StickerProcessor: ffmpeg failed, ${e.message}`);
        return null;
    } finally {
        await Promise.all([
            unlink(inputPath).catch(() => { }),
            unlink(outputPath).catch(() => { })
        ]);
    }


}