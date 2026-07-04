// ============================================================
// Oozo Route — Process D:\Oozo product folders
// POST /api/oozo/process — process a single folder
// POST /api/oozo/scan — scan for new folders
// ============================================================

import { Router } from "express";
import { join } from "node:path";
import { logger } from "@onzo/logger";
import type { OozoProduct } from "../services/oozo-processor.js";
import { scanProductFolder, saveResult, scanForNewProducts, startWatching } from "../services/oozo-processor.js";
import type { DeepSeekClient } from "@onzo/glm-integration";
import type { GlmVisionClient } from "@onzo/glm-integration";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { analyzeImage, generateImageOverlayText, applyOverlay } from "../services/image-russianizer.js";
import { generateVideoScript, generateVoiceover, generateSubtitles, processVideoAsync } from "../services/video-russianizer.js";
import { notifier } from "../services/notifier.js";

export function createOozoRouter(
  deepseekClient: DeepSeekClient,
  visionClient: GlmVisionClient,
  ozonClient: OzonClient
): Router {
  const router = Router();

  // POST /api/oozo/process — process a product folder by name
  router.post("/oozo/process", async (req, res) => {
    const { folderName } = req.body as { folderName: string };
    if (!folderName) {
      res.status(400).json({ success: false, error: { code: "MISSING_FOLDER", message: "folderName required" } });
      return;
    }

    const watchDir = process.env.OOZO_WATCH_DIR || "D:/下载";
    const folderPath = join(watchDir, folderName);

    try {
      const product = await scanProductFolder(folderPath, folderName);
      if (product.isDuplicate) {
        res.status(200).json({
          success: true,
          data: { folderName, fingerprint: product.fingerprint, duplicate: true },
          message: "Duplicate product — already processed, skipping",
        });
        return;
      }
      if (product.files.images.length === 0 && product.files.videos.length === 0) {
        res.status(404).json({ success: false, error: { code: "EMPTY_FOLDER", message: "No images or videos found in original/" } });
        return;
      }

      res.status(202).json({
        success: true,
        data: { folderName, images: product.files.images.length, videos: product.files.videos.length },
        message: "Processing started",
      });

      // Process async
      await processProductFolder(product, deepseekClient, visionClient, ozonClient);
    } catch (err) {
      logger.error({ folderName, err }, "Oozo process failed");
    }
  });

  // POST /api/oozo/scan — scan and process ALL unprocessed folders
  router.post("/oozo/scan", async (_req, res) => {
    try {
      const products = await scanForNewProducts();
      res.status(202).json({
        success: true,
        data: { found: products.length, folders: products.map((p) => p.folderName) },
        message: `Processing ${products.length} folders`,
      });

      for (const product of products) {
        await processProductFolder(product, deepseekClient, visionClient, ozonClient).catch((err) => {
          logger.error({ folder: product.folderName, err }, "Oozo scan processing failed");
        });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SCAN_FAILED", message: (err as Error).message } });
    }
  });

  return router;
}

/**
 * Process a single product folder: images → Russian overlay, videos → Russian voiceover.
 */
async function processProductFolder(
  product: Awaited<ReturnType<typeof scanProductFolder>>,
  deepseekClient: DeepSeekClient,
  visionClient: GlmVisionClient,
  ozonClient: OzonClient
): Promise<void> {
  const startTime = Date.now();
  product.status = "processing";
  await saveResult(product);

  let imageCount = 0;
  let videoCount = 0;
  const errors: string[] = [];

  // ---- Phase 1: Process Images ----
  if (product.files.images.length > 0) {
    logger.info({ count: product.files.images.length, folder: product.folderName }, "Oozo — processing images");

    const specFromName = product.productName
      .replace(/[，,]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);

    for (const imgFile of product.files.images) {
      try {
        // imgFile is like "主图/img001.jpg" — resolve to absolute path
        const imgPath = join(product.paths.root, imgFile);
        const fileUrl = `file:///${imgPath.replace(/\\/g, "/")}`;

        // 1. Analyze image
        const analysis = await analyzeImage(visionClient, fileUrl);

        // 2. Generate Russian overlay text
        const overlays = await generateImageOverlayText(deepseekClient, analysis, {
          titleCn: product.productName,
          specs: specFromName.map((s) => ({ name: "", value: s })),
        });

        // 3. Apply overlay
        await applyOverlay(imgPath, product.paths.modifiedImages, overlays);
        imageCount++;
      } catch (err) {
        errors.push(`Image ${imgFile}: ${(err as Error).message}`);
      }
    }
  }

  // ---- Phase 2: Process Videos ----
  if (product.files.videos.length > 0) {
    logger.info({ count: product.files.videos.length, folder: product.folderName }, "Oozo — processing videos");

    for (const vidFile of product.files.videos) {
      try {
        // vidFile is like "视频/video001.mp4" — resolve to absolute path
        const vidPath = join(product.paths.root, vidFile);

        // 1. Generate Russian script (use CSV data if available)
        const csvInfo = product.csvData;
        const descriptionCn = csvInfo
          ? `${csvInfo["标题"] || csvInfo["title"] || product.productName}. ${csvInfo["属性"] || csvInfo["规格"] || ""}`
          : `Товар: ${product.productName}`;

        const script = await generateVideoScript(deepseekClient, {
          titleCn: csvInfo?.["标题"] || csvInfo?.["title"] || product.productName,
          descriptionCn,
        });

        // 2. Generate voiceover (Edge TTS)
        const voiceoverPath = await generateVoiceover(
          script.narrationRu,
          product.paths.modifiedVideos
        );

        // 3. Generate SRT subtitles
        const srtPath = await generateSubtitles(
          script.subtitles,
          product.paths.modifiedVideos
        );

        // 4. Enqueue video to async FFmpeg queue (non-blocking)
        await processVideoAsync(
          vidPath, voiceoverPath, srtPath,
          product.paths.modifiedVideos,
          product.productName
        );
        videoCount++;
      } catch (err) {
        errors.push(`Video ${vidFile}: ${(err as Error).message}`);
      }
    }
  }

  // ---- Phase 3: Save results ----
  const durationSec = Math.round((Date.now() - startTime) / 1000);
  product.status = errors.length > 0 && imageCount + videoCount === 0 ? "failed" : "done";
  product.result = {
    titleCn: product.csvData?.["标题"] || product.csvData?.["title"] || product.productName,
    titleRu: "",
    descriptionRu: "",
    imageCount,
    videoCount,
    processedAt: new Date().toISOString(),
    csvFields: product.csvData ?? undefined,
  };
  if (errors.length > 0) product.error = errors.join("; ");

  await saveResult(product);

  logger.info(
    { folder: product.folderName, images: imageCount, videos: videoCount, durationSec },
    "Oozo — processing complete"
  );

  // Notify
  await notifier.notify({
    level: errors.length > 0 ? "warn" : "info",
    event: "Oozo素材处理",
    message: `${product.folderName}: ${imageCount}图片 ${videoCount}视频 处理完成 (${durationSec}s)`,
    correlationId: `oozo-${product.folderName}`,
    metadata: { images: String(imageCount), videos: String(videoCount), errors: String(errors.length) },
  }).catch(() => {});
}
