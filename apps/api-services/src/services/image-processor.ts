// ============================================================
// Image Processor — download + optimize + store locally
// 3:4 crop for Ozon, sharp optimization, local cache
// ============================================================

import { logger } from "@onzo/logger";
import { mkdirSync, existsSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const IMG_DIR = process.env.IMAGE_STORAGE_PATH || "./data/images";
const RAW_DIR = join(IMG_DIR, "raw");
const PREPROCESSED_DIR = join(IMG_DIR, "preprocessed");
const OPTIMIZED_DIR = join(IMG_DIR, "optimized");
const OZON_MAX_IMAGES = 10;

// Ensure directories exist
for (const dir of [IMG_DIR, RAW_DIR, PREPROCESSED_DIR, OPTIMIZED_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface ProcessedImage {
  originalUrl: string;
  localPath: string;
  localUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  optimized: boolean;
  backgroundRemoved: boolean;
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

// ============================================================
// P3: Background Removal + Three-Tier Image Preprocessing
// ============================================================

/**
 * Remove background from image, output white-background PNG.
 * Uses @imgly/background-removal-node (ONNX/WASM, Alpine-compatible).
 */
export async function removeBackground(inputPath: string): Promise<string | null> {
  try {
    const { removeBackground: imglyRemoveBg } = await import("@imgly/background-removal-node");
    const inputBuf = readFileSync(inputPath);
    const blob = new Blob([inputBuf]);
    const resultBlob = await imglyRemoveBg(blob, {
      model: "isnet_quint8",
      output: { format: "image/png" },
    });
    const resultBuf = Buffer.from(await resultBlob.arrayBuffer());
    const filename = `nobg_${randomUUID()}.png`;
    const outputPath = join(PREPROCESSED_DIR, filename);
    writeFileSync(outputPath, resultBuf);
    logger.info({ input: inputPath.split(/[/\\]/).pop(), output: filename }, "Background removed");
    return outputPath;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Background removal failed — continuing with original");
    return null;
  }
}

/**
 * Preprocess image for Ozon:
 * 1. Remove background → white background PNG
 * 2. 1:1 center crop → 1200x1200
 * 3. JPEG compression → quality 90%
 */
export async function preprocessForOzon(inputPath: string): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;

    // Step 1: Background removal (optional, graceful fallback)
    let workingPath = inputPath;
    if (process.env.IMAGE_BG_REMOVAL_ENABLE !== "false") {
      const nobgPath = await removeBackground(inputPath);
      if (nobgPath) workingPath = nobgPath;
    }

    // Step 2: 1:1 square crop (Ozon primary image requirement)
    const filename = `ozon_${randomUUID()}.jpg`;
    const outputPath = join(PREPROCESSED_DIR, filename);

    await sharp(workingPath)
      .resize(1200, 1200, { fit: "cover", position: "center" }) // 1:1 square
      .jpeg({ quality: 90, progressive: true })
      .toFile(outputPath);

    return outputPath;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Preprocess failed — returning original");
    return inputPath;
  }
}

/**
 * Enhanced pipeline: download → preprocess (rembg + 1:1 crop) → return URLs.
 * Three-tier storage: raw/ → preprocessed/ → (GLM) optimized/
 */
export async function processImagesEnhanced(imageUrls: string[]): Promise<{
  localUrls: string[];
  localPaths: string[];
  failed: number;
  preprocessed: number;
  backgroundRemoved: number;
}> {
  const localUrls: string[] = [];
  const localPaths: string[] = [];
  let failed = 0;
  let preprocessed = 0;
  let backgroundRemoved = 0;

  for (const url of imageUrls.slice(0, OZON_MAX_IMAGES)) {
    // Step 1: Download to raw/
    const rawPath = await downloadImage(url);
    if (!rawPath) { failed++; continue; }

    // Step 2: Preprocess (background removal + 1:1 crop)
    const ppPath = await preprocessForOzon(rawPath);
    if (ppPath && ppPath !== rawPath) {
      preprocessed++;
      if (ppPath.includes("nobg_")) backgroundRemoved++;
    }

    const finalPath = ppPath || rawPath;
    localPaths.push(finalPath);

    // Build local URL
    const filename = finalPath.split(/[/\\]/).pop() || "";
    localUrls.push(`https://huashangshangmao.top/images/${filename}`);
  }

  logger.info({
    total: imageUrls.length,
    downloaded: localPaths.length,
    preprocessed,
    backgroundRemoved,
    failed,
  }, "ImageProcessor Enhanced: batch complete");

  return { localUrls, localPaths, failed, preprocessed, backgroundRemoved };
}

/** Export directories for Express static serving */
export function getImageDirs(): { raw: string; preprocessed: string; optimized: string } {
  return { raw: RAW_DIR, preprocessed: PREPROCESSED_DIR, optimized: OPTIMIZED_DIR };
}
