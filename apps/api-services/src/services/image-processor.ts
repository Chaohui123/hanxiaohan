// ============================================================
// Image Processor — download + optimize + store locally
// 3:4 crop for Ozon, sharp optimization, local cache
// ============================================================

import { logger } from "@onzo/logger";
import { mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const IMG_DIR = process.env.IMAGE_STORAGE_PATH || "./data/images";
const OZON_MAX_IMAGES = 10;

// Ensure directory exists
if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true });

export interface ProcessedImage {
  originalUrl: string;
  localPath: string;
  localUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  optimized: boolean;
  error?: string;
}

/**
 * Download image from URL and save to local storage.
 * Returns local path and URL.
 */
export async function downloadImage(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://detail.1688.com/",
        "Accept": "image/avif,image/webp,image/*",
      },
    });
    if (!resp.ok) return null;

    const ext = url.match(/\.(jpg|jpeg|png|webp)/i)?.[0] || ".jpg";
    const filename = `${randomUUID()}${ext}`;
    const filepath = join(IMG_DIR, filename);

    const body = resp.body;
    if (!body) return null;

    const writer = createWriteStream(filepath);
    await pipeline(body as unknown as NodeJS.ReadableStream, writer);

    return filepath;
  } catch (err) {
    logger.warn({ url: url.slice(0, 60), err: (err as Error).message }, "Image download failed");
    return null;
  }
}

/**
 * Optimize image for Ozon: 3:4 crop, resize, quality.
 * Uses sharp (already in package.json dependencies).
 */
export async function optimizeForOzon(inputPath: string): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    const filename = `opt_${randomUUID()}.jpg`;
    const outputPath = join(IMG_DIR, filename);

    await sharp(inputPath)
      .resize(900, 1200, { fit: "cover", position: "center" })  // 3:4 ratio
      .jpeg({ quality: 90, progressive: true })
      .toFile(outputPath);

    return outputPath;
  } catch {
    // sharp may not be installed — return original
    return inputPath;
  }
}

/**
 * Full pipeline: download + optimize + return local URLs.
 * Stops after OZON_MAX_IMAGES (10).
 */
export async function processImages(imageUrls: string[]): Promise<{
  localUrls: string[];
  localPaths: string[];
  failed: number;
  optimized: number;
}> {
  const localUrls: string[] = [];
  const localPaths: string[] = [];
  let failed = 0;
  let optimized = 0;

  for (const url of imageUrls.slice(0, OZON_MAX_IMAGES)) {
    // Download
    const localPath = await downloadImage(url);
    if (!localPath) { failed++; continue; }

    // Optimize (3:4 crop)
    const optPath = await optimizeForOzon(localPath);
    if (optPath && optPath !== localPath) optimized++;

    const finalPath = optPath || localPath;
    localPaths.push(finalPath);

    // Build local URL (served by Express static)
    const filename = finalPath.split(/[/\\]/).pop() || "";
    localUrls.push(`https://huashangshangmao.top/images/${filename}`);
  }

  logger.info({ total: imageUrls.length, downloaded: localPaths.length, optimized, failed },
    "ImageProcessor: batch complete");

  return { localUrls, localPaths, failed, optimized };
}

/**
 * Process images and return only the local URLs (for Ozon API).
 */
export async function getOptimizedImageUrls(imageUrls: string[]): Promise<string[]> {
  const { localUrls } = await processImages(imageUrls);
  return localUrls;
}
