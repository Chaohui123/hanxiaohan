// ============================================================
// Image Upload Route — receive local files, optimize, store
// POST /api/image/upload — multipart file upload
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import multer from "multer";

const IMG_DIR = process.env.IMAGE_STORAGE_PATH || "./data/images";
if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: IMG_DIR,
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || ".jpg";
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 15 }, // 20MB per file, 15 max
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|gif)$/i;
    cb(null, allowed.test(file.originalname));
  },
});

export function createImageUploadRouter(): Router {
  const router = Router();

  // POST /api/image/upload — batch upload images
  router.post("/image/upload", upload.array("images", 15), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ success: false, error: { code: "NO_FILES", message: "No image files provided" } });
      }

      const results: Array<{ originalName: string; savedAs: string; url: string; optimized: boolean }> = [];

      for (const file of files) {
        const optimized = await optimizeFile(file.path);
        const finalPath = optimized || file.path;
        const filename = finalPath.split(/[/\\]/).pop() || file.filename;

        results.push({
          originalName: file.originalname,
          savedAs: filename,
          url: `https://huashangshangmao.top/images/${filename}`,
          optimized: !!optimized,
        });
      }

      logger.info({ count: results.length }, "Image upload complete");

      res.json({
        success: true,
        data: {
          uploaded: results.length,
          images: results,
          urls: results.map(r => r.url),
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "UPLOAD_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}

async function optimizeFile(filepath: string): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    const outPath = filepath.replace(/\.\w+$/, "_opt.jpg");
    await sharp(filepath)
      .resize(900, 1200, { fit: "cover", position: "center" })
      .jpeg({ quality: 90, progressive: true })
      .toFile(outPath);
    return outPath;
  } catch {
    return null; // sharp not available — use original
  }
}
