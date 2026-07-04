// ============================================================
// Video Russianizer — Chinese → Russian localized video
// 1. DeepSeek generates concise Russian narration script
// 2. Edge TTS generates Russian voiceover (free, no API key)
// 3. ffmpeg burns Russian subtitles + replaces audio
// ============================================================

import { execFile } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { logger } from "@onzo/logger";
import { ffmpegQueue } from "./async-queue.js";

export type VideoProcessCallback = (result: { success: boolean; outputPath?: string; error?: string }) => void;

export interface VideoScript {
  /** Concise Russian narration (2-4 sentences for a 30s video) */
  narrationRu: string;
  /** Russian subtitles with timestamps (SRT format) */
  subtitles: Array<{ start: number; end: number; text: string }>;
  /** Russian title for the video */
  titleRu: string;
}

export interface VideoProcessResult {
  success: boolean;
  outputPath: string;
  script: VideoScript;
  error?: string;
}

/**
 * Generate Russian video script from product info using DeepSeek.
 */
export async function generateVideoScript(
  deepseekClient: { chatCompletion: (opts: { model: string; messages: Array<{ role: string; content: string }>; temperature: number; maxTokens: number; responseFormat: { type: string } }) => Promise<{ parsed: VideoScript | null; content: string }> },
  productInfo: { titleCn: string; descriptionCn: string; specs?: Array<{ name: string; value: string }> }
): Promise<VideoScript> {
  const specsText = (productInfo.specs ?? []).map((s) => `${s.name}: ${s.value}`).join(", ");

  const prompt = `You are a Russian e-commerce copywriter. Write a CONCISE video narration script for Ozon marketplace.

Product (Chinese): ${productInfo.titleCn}
Description: ${productInfo.descriptionCn}
Specifications: ${specsText}

Requirements:
- 2-4 short sentences total (fits ~25-40 seconds of narration)
- Natural spoken Russian, NOT marketing fluff
- Focus on 1-2 key selling points, not everything
- Generate SRT subtitles with rough timestamps (assume ~6 seconds per sentence)

Return JSON:
{
  "titleRu": "Краткое название товара",
  "narrationRu": "Полный текст закадрового голоса. Короткие предложения.",
  "subtitles": [
    {"start": 0, "end": 6, "text": "Первое предложение"},
    {"start": 6, "end": 12, "text": "Второе предложение"}
  ]
}`;

  const response = await deepseekClient.chatCompletion({
    model: "flash",
    messages: [
      { role: "system", content: "You are a Russian e-commerce video script writer. Return only valid JSON." },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    maxTokens: 2000,
    responseFormat: { type: "json_object" },
  });

  if (response.parsed) return response.parsed;

  // Fallback: generate default script
  return {
    titleRu: productInfo.titleCn,
    narrationRu: `Представляем ${productInfo.titleCn}. ${productInfo.descriptionCn.substring(0, 200)}`,
    subtitles: [
      { start: 0, end: 6, text: `Представляем ${productInfo.titleCn}` },
      { start: 6, end: 12, text: productInfo.descriptionCn.substring(0, 200) },
    ],
  };
}

/**
 * Generate Russian TTS voiceover using Microsoft Edge TTS (free, no key needed).
 * Returns the path to the generated WAV/MP3 file.
 */
export async function generateVoiceover(
  text: string,
  outputDir: string,
  voice: string = "ru-RU-DariyaNeural"
): Promise<string> {
  const outputPath = join(outputDir, "voiceover.mp3");
  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

  // Use edge-tts via npx (installed on demand)
  // edge-tts --voice ru-RU-DariyaNeural --text "..." --write-media output.mp3
  return new Promise<string>((resolve, reject) => {
    // Escape special characters for command line
    const escaped = text.replace(/"/g, '\\"').replace(/\n/g, " ");

    execFile(
      "npx",
      ["-y", "edge-tts", "--voice", voice, "--text", escaped, "--write-media", outputPath],
      { timeout: 60_000 },
      (err) => {
        if (err) {
          // edge-tts not available — generate silent audio as fallback
          logger.warn({ err: err.message }, "edge-tts failed, generating silent voiceover");
          generateSilentAudio(text, outputPath)
            .then(() => resolve(outputPath))
            .catch(reject);
        } else {
          logger.info({ output: outputPath }, "Voiceover generated");
          resolve(outputPath);
        }
      }
    );
  });
}

/**
 * Generate SRT subtitle file.
 */
export async function generateSubtitles(
  subtitles: Array<{ start: number; end: number; text: string }>,
  outputDir: string
): Promise<string> {
  const srtPath = join(outputDir, "subtitles.srt");
  const srtContent = subtitles
    .map((sub, i) => {
      const startTime = formatSrtTime(sub.start);
      const endTime = formatSrtTime(sub.end);
      return `${i + 1}\n${startTime} --> ${endTime}\n${sub.text}\n`;
    })
    .join("\n");

  await writeFile(srtPath, srtContent, "utf-8");
  return srtPath;
}

/**
 * Process video SYNCHRONOUSLY via ffmpeg (legacy, use processVideoAsync for API endpoints).
 * Blocks until transcoding completes.
 */
export async function processVideo(
  inputVideoPath: string,
  voiceoverPath: string,
  srtPath: string,
  outputDir: string
): Promise<string> {
  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

  const inputName = basename(inputVideoPath, extname(inputVideoPath));
  const outputPath = join(outputDir, `${inputName}_ru.mp4`);

  return new Promise<string>((resolve, reject) => {
    const srtPathSafe = srtPath.replace(/\\/g, "/");
    const outputPathSafe = outputPath.replace(/\\/g, "/");

    const args = [
      "-i", inputVideoPath.replace(/\\/g, "/"),
      "-i", voiceoverPath.replace(/\\/g, "/"),
      "-vf", `subtitles='${srtPathSafe}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Alignment=2'`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-y",
      outputPathSafe,
    ];

    logger.info({ input: inputVideoPath, output: outputPath }, "ffmpeg processing video (sync)");

    execFile("ffmpeg", args, { timeout: 300_000 }, (err) => {
      if (err) {
        logger.warn({ err: err.message }, "ffmpeg failed");
        reject(new Error(`ffmpeg failed: ${err.message}`));
      } else {
        logger.info({ output: outputPath }, "Video processing complete");
        resolve(outputPath);
      }
    });
  });
}

/**
 * Process video ASYNCHRONOUSLY via ffmpegQueue.
 * Returns immediately; video is transcoded in background.
 * Use this for API endpoints to avoid blocking the request.
 */
export async function processVideoAsync(
  inputVideoPath: string,
  voiceoverPath: string,
  srtPath: string,
  outputDir: string,
  productName: string,
  onComplete?: VideoProcessCallback
): Promise<string> {
  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

  const inputName = basename(inputVideoPath, extname(inputVideoPath));
  const outputPath = join(outputDir, `${inputName}_ru.mp4`);

  const taskId = await ffmpegQueue.enqueue("transcode", {
    inputPath: inputVideoPath,
    voiceoverPath,
    srtPath,
    outputDir,
    productName,
  });

  // Register handler for ffmpeg queue
  if (!ffmpegQueue["handlers"].has("transcode")) {
    ffmpegQueue.registerHandler("transcode", async (task) => {
      const { inputPath, voiceoverPath, srtPath, outputDir } = task.data;
      await processVideo(inputPath, voiceoverPath, srtPath, outputDir);
    });

    ffmpegQueue.onFailed(async (task, error) => {
      logger.error({ taskId: task.id, error, product: task.data.productName }, "FFmpeg transcode failed after all retries");
      onComplete?.({ success: false, error });
    });
  }

  return outputPath; // Return expected output path (video will appear when done)
}

// ---- Helpers ----

function extname(path: string): string {
  const m = path.match(/\.[^.]+$/);
  return m ? m[0] : "";
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * Generate silent audio of correct duration as fallback when TTS is unavailable.
 */
async function generateSilentAudio(text: string, outputPath: string): Promise<void> {
  // Estimate duration: ~3 words per second in Russian
  const wordCount = text.split(/\s+/).length;
  const durationSec = Math.max(3, Math.ceil(wordCount / 3));

  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono`, "-t", String(durationSec), "-c:a", "libmp3lame", "-y", outputPath],
      { timeout: 10_000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
