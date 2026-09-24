import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

import { log } from "./Logger.js"

// Magic param strings came from Thororen & Equicord team (MoreStickers & Fake Nitros plugin)
// https://github.com/Equicord/Equicord/commits/main/src/equicordplugins/moreStickers
// I suck at ffmpeg so awesome work. Especially the animated one. 

const STATIC_PARAMS =
    "scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x00000000"

const ANIMATED_PARAMS =
    "format=rgba,scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2:color=0x00000000,split[s0][s1];[s0]palettegen=reserve_transparent=on:transparency_color=00000000[p];[s1][p]paletteuse=alpha_threshold=128";

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

    let ext
    if (animated) {
        ext = "gif";
    } else {
        ext = "png";
    }

    let args;
    if (animated) {
        args = [
            "-y",
            "-i", "pipe:0",
            "-filter_complex", ANIMATED_PARAMS,
            "-f", "gif",
            "pipe:1"
        ];
    } else {
        args = [
            "-y",
            "-i", "pipe:0",
            "-vf", STATIC_PARAMS,
            "-pix_fmt", "rgba",
            "-frames:v", "1",
            "-f", "image2pipe",
            "-c:v", "png",
            "pipe:1"
        ];
    }

    try {
        const buffer = await new Promise((resolve, reject) => {
            const ffmpeg = spawn("ffmpeg", args);
            const outChunks = [];
            let errorLog = "";

            ffmpeg.stdout.on("data", (chunk) => {
                outChunks.push(chunk);
            });

            ffmpeg.stderr.on("data", (chunk) => {
                errorLog += chunk.toString();
            });

            ffmpeg.on("error", (err) => {
                reject(err);
            });

            ffmpeg.on("close", (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(outChunks));
                } else {
                    reject(new Error(`ffmpeg exited with code ${code}: ${errorLog}`));
                }
            });

            ffmpeg.stdin.end(rawBuffer);
        });

        return { buffer, filename: `${name}.${ext}` };
    } catch (e) {
        log("DEBUG", `StickerProcessor: ffmpeg failed, ${e.message}`);
        return null;
    }
}