// ============================================================
// Image Upload Route — native stream, no multer dependency
// POST /api/image/upload — multipart file upload
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

const IMG_DIR = process.env.IMAGE_STORAGE_PATH || "./data/images";
if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true });

const MAX_FILES = 15;
const MAX_SIZE = 20 * 1024 * 1024;

export function createImageUploadRouter(): Router {
  const router = Router();

  router.post("/image/upload", async (req, res) => {
    try {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        return res.status(400).json({ success: false, error: { code: "BAD_FORMAT", message: "Use multipart/form-data" } });
      }

      const boundary = contentType.match(/boundary=(.+)/)?.[1];
      if (!boundary) return res.status(400).json({ success: false, error: { code: "NO_BOUNDARY" } });

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
      const raw = Buffer.concat(chunks);

      // Parse multipart: find image files
      const results: Array<{ originalName: string; savedAs: string; url: string }> = [];
      const parts = raw.toString("binary").split("--" + boundary);

      for (const part of parts) {
        if (!part.includes("Content-Disposition") || !part.includes("filename=")) continue;

        const nameMatch = part.match(/filename="([^"]+)"/);
        const originalName = nameMatch?.[1] || "image.jpg";

        // Find binary data after \r\n\r\n
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const dataStart = headerEnd + 4;
        let dataEnd = part.lastIndexOf("\r\n--");
        if (dataEnd < 0) dataEnd = part.lastIndexOf("\r\n");
        if (dataEnd < dataStart) continue;

        const imageData = Buffer.from(part.slice(dataStart, dataEnd), "binary");
        if (imageData.length > MAX_SIZE || imageData.length < 1000) continue;

        const ext = extname(originalName).toLowerCase();
        if (![".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) continue;

        const filename = `${randomUUID()}${ext}`;
        const filepath = join(IMG_DIR, filename);
        createWriteStream(filepath).end(imageData);

        // Optimize: 3:4 crop
        try {
          const sharp = (await import("sharp")).default;
          const optPath = filepath.replace(/\.\w+$/, "_opt.jpg");
          await sharp(filepath).resize(900, 1200, { fit: "cover", position: "center" })
            .jpeg({ quality: 90, progressive: true }).toFile(optPath);
          results.push({
            originalName,
            savedAs: optPath.split(/[/\\]/).pop() || filename,
            url: `https://huashangshangmao.top/images/${optPath.split(/[/\\]/).pop()}`,
          });
        } catch {
          results.push({
            originalName,
            savedAs: filename,
            url: `https://huashangshangmao.top/images/${filename}`,
          });
        }

        if (results.length >= MAX_FILES) break;
      }

      if (results.length === 0) {
        return res.status(400).json({ success: false, error: { code: "NO_IMAGES", message: "No valid images found" } });
      }

      logger.info({ count: results.length }, "Image upload complete");
      res.json({
        success: true,
        data: { uploaded: results.length, images: results, urls: results.map(r => r.url) },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "UPLOAD_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}
