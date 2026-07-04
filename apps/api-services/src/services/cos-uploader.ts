// ============================================================
// COS (Tencent Cloud Object Storage) Image Uploader
// Concurrent queue control (max 5) + rate limiting + dead letter
// ============================================================

import COS from "cos-nodejs-sdk-v5";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { logger } from "@onzo/logger";
import { writeToDeadLetter } from "./dead-letter.js";

// ---- Types ----

export interface UploadResult {
  success: boolean;
  url?: string;
  cosKey?: string;
  error?: string;
  isDeadLetter?: boolean;
  retryCount?: number;
}

export interface ImageRecord {
  id: string;
  productId: string;
  cosKey: string;
  url: string;
  status: "success" | "failed" | "pending" | "dead_letter";
  retryCount: number;
  deadLetter: boolean;
  localPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Concurrency Limiter (self-contained, no external deps) ----

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

class ConcurrencyLimiter {
  private queue: QueueItem<unknown>[] = [];
  private active = 0;
  private completed = 0;
  private failed = 0;
  private lastMonitorLog = Date.now();

  constructor(
    private maxConcurrency: number,
    private name: string,
    private monitorIntervalMs: number = 10_000
  ) {}

  /**
   * Execute a function with concurrency control.
   * If at capacity, the call is queued until a slot frees up.
   */
  async executeWithLimit<T>(fn: () => Promise<T>): Promise<T> {
    // Fast path: slot available immediately
    if (this.active < this.maxConcurrency) {
      this.active++;
      try {
        const result = await fn();
        this.completed++;
        return result;
      } catch (err) {
        this.failed++;
        throw err;
      } finally {
        this.active--;
        this.monitorQueue();
        this.processQueue();
      }
    }

    // Slow path: queue and wait
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject } as QueueItem<unknown>);
      this.monitorQueue();
    });
  }

  /** Get current queue stats */
  getStats() {
    return {
      name: this.name,
      active: this.active,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      completed: this.completed,
      failed: this.failed,
    };
  }

  /** Drain pending queue items */
  private processQueue(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      item
        .fn()
        .then((result) => {
          this.completed++;
          item.resolve(result);
        })
        .catch((err) => {
          this.failed++;
          item.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          this.active--;
          this.processQueue();
        });
    }
  }

  /**
   * Monitor queue length — logs when backlog exceeds threshold.
   * Logs at most once per monitorIntervalMs to avoid spam.
   */
  private monitorQueue(): void {
    const now = Date.now();
    if (now - this.lastMonitorLog < this.monitorIntervalMs) return;
    this.lastMonitorLog = now;

    const stats = this.getStats();
    if (this.queue.length > 0) {
      logger.info(stats, `[${this.name}] Queue monitor`);
    }
    if (this.queue.length > this.maxConcurrency * 3) {
      logger.warn(stats, `[${this.name}] Queue backlog > 3x concurrency — consider scaling`);
    }
  }
}

// ---- CosUploader ----

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000];
const MAX_CONCURRENCY = 5;

export class CosUploader {
  private cos: COS;
  private bucket: string;
  private region: string;
  private baseUrl: string;
  private deadLetterDir: string;
  private limiter: ConcurrencyLimiter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(db?: any) {
    this.cos = new COS({
      SecretId: process.env.COS_SECRET_ID || "",
      SecretKey: process.env.COS_SECRET_KEY || "",
    });
    this.bucket = process.env.COS_BUCKET || "";
    this.region = process.env.COS_REGION || "ap-shanghai";
    this.baseUrl = process.env.COS_BASE_URL || "";
    this.deadLetterDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
    this.db = db;
    this.limiter = new ConcurrencyLimiter(MAX_CONCURRENCY, "cos-upload");

    if (!existsSync(this.deadLetterDir)) {
      mkdirSync(this.deadLetterDir, { recursive: true });
    }

    logger.info({ maxConcurrency: MAX_CONCURRENCY }, "COS uploader initialized");
  }

  /**
   * Upload a single image through the concurrency limiter.
   * Includes 3 retries with exponential backoff.
   */
  async uploadImage(filePath: string, productId: string, customKey?: string): Promise<UploadResult> {
    const ext = extname(filePath) || ".jpg";
    const hash = createHash("md5").update(readFileSync(filePath)).digest("hex").substring(0, 12);
    const cosKey = customKey || `products/${productId}/${hash}${ext}`;

    return this.limiter.executeWithLimit(async () => {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await this.cosUpload(filePath, cosKey);
          const url = `${this.baseUrl}/${cosKey}`;
          await this.recordUpload({
            id: randomUUID(), productId, cosKey, url,
            status: "success", retryCount: attempt, deadLetter: false,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
          return { success: true, url, cosKey, retryCount: attempt };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`[COS] Upload attempt ${attempt + 1}/${MAX_RETRIES}: ${cosKey} — ${errMsg}`);
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
            continue;
          }
          return this.saveToDeadLetter(filePath, productId, cosKey, errMsg);
        }
      }
      return { success: false, error: "Max retries exceeded" };
    });
  }

  /**
   * Batch upload with full concurrency control.
   * All images go through executeWithLimit — max 5 concurrent uploads.
   * Individual failures don't block the batch.
   */
  async uploadImagesBatch(
    files: Array<{ filePath: string; productId: string; key?: string }>
  ): Promise<UploadResult[]> {
    const stats = this.limiter.getStats();
    logger.info({ fileCount: files.length, ...stats }, "[COS] Batch upload started");

    const startTime = Date.now();

    // Each file goes through the limiter → max 5 concurrent
    const results = await Promise.allSettled(
      files.map((f) => this.uploadImage(f.filePath, f.productId, f.key))
    );

    const elapsed = Date.now() - startTime;
    const finalStats = this.limiter.getStats();

    const mapped = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        success: false,
        error: r.reason?.message || "Unknown error",
        isDeadLetter: false,
        cosKey: files[i]?.key,
      } as UploadResult;
    });

    const succeeded = mapped.filter((r) => r.success).length;
    const failed = mapped.filter((r) => !r.success).length;

    logger.info(
      { succeeded, failed, total: files.length, elapsedMs: elapsed, ...finalStats },
      "[COS] Batch upload complete"
    );

    return mapped;
  }

  /** Get a public COS URL */
  getImageUrl(cosKey: string): string {
    return `${this.baseUrl}/${cosKey}`;
  }

  /** Delete an image from COS */
  async deleteImage(cosKey: string): Promise<boolean> {
    try {
      await this.cosDelete(cosKey);
      return true;
    } catch (error) {
      logger.error(`[COS] Delete failed: ${cosKey}`, error);
      return false;
    }
  }

  /** Retry all dead-letter images */
  async retryDeadLetterImages(): Promise<UploadResult[]> {
    const deadLetterFiles = this.getDeadLetterFiles();
    if (deadLetterFiles.length === 0) return [];

    logger.info({ count: deadLetterFiles.length }, "[COS] Retrying dead letter images");

    const results: UploadResult[] = [];
    for (const file of deadLetterFiles) {
      try {
        const meta = this.readDeadLetterMeta(file);
        if (!meta) continue;
        const result = await this.uploadImage(meta.filePath, meta.productId, meta.cosKey);
        results.push(result);
        if (result.success) this.removeDeadLetterFile(file);
      } catch (error) {
        results.push({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          isDeadLetter: true,
        });
      }
    }
    return results;
  }

  /** Get current limiter stats for monitoring */
  getQueueStats() {
    return this.limiter.getStats();
  }

  // ---- Private helpers ----

  private cosUpload(filePath: string, key: string): Promise<COS.PutObjectResult> {
    return new Promise((resolve, reject) => {
      this.cos.uploadFile(
        { Bucket: this.bucket, Region: this.region, Key: key, FilePath: filePath },
        (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }
      );
    });
  }

  private cosDelete(key: string): Promise<COS.DeleteObjectResult> {
    return new Promise((resolve, reject) => {
      this.cos.deleteObject(
        { Bucket: this.bucket, Region: this.region, Key: key },
        (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }
      );
    });
  }

  private async saveToDeadLetter(
    filePath: string, productId: string, cosKey: string, error: string
  ): Promise<UploadResult> {
    const fileName = `${productId}_${createHash("md5").update(cosKey).digest("hex").substring(0, 8)}${extname(filePath)}`;
    const localPath = join(this.deadLetterDir, fileName);
    try {
      writeFileSync(localPath, readFileSync(filePath));
      writeFileSync(`${localPath}.meta.json`, JSON.stringify({
        productId, cosKey, originalPath: filePath, error,
        savedAt: new Date().toISOString(),
      }));
      await this.recordUpload({
        id: randomUUID(), productId, cosKey, url: "",
        status: "dead_letter", retryCount: MAX_RETRIES, deadLetter: true,
        localPath, error, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    } catch (dlError) {
      logger.error("[COS] Dead letter save also failed:", dlError);
    }
    // Also write to global dead letter for centralized retry
    await writeToDeadLetter({
      taskType: "cos_upload",
      errorMessage: error,
      payload: { filePath, productId, cosKey },
    }).catch(() => {});
    return { success: false, isDeadLetter: true, error, cosKey };
  }

  private getDeadLetterFiles(): string[] {
    if (!existsSync(this.deadLetterDir)) return [];
    return readdirSync(this.deadLetterDir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => join(this.deadLetterDir, f));
  }

  private readDeadLetterMeta(metaPath: string): {
    filePath: string; productId: string; cosKey: string;
  } | null {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const imagePath = metaPath.replace(".meta.json", "");
      if (existsSync(imagePath)) {
        return { filePath: imagePath, productId: meta.productId, cosKey: meta.cosKey };
      }
    } catch { /* ignore */ }
    return null;
  }

  private removeDeadLetterFile(metaPath: string): void {
    try {
      const imagePath = metaPath.replace(".meta.json", "");
      if (existsSync(imagePath)) { unlinkSync(imagePath); unlinkSync(metaPath); }
    } catch { /* ignore */ }
  }

  private async recordUpload(record: ImageRecord): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS images (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL, cos_key TEXT NOT NULL UNIQUE,
          url TEXT, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER DEFAULT 0,
          dead_letter INTEGER DEFAULT 0, local_path TEXT, error TEXT,
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_images_product ON images(product_id);
        CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
      `);
      const esc = (s?: string) => (s ? s.replace(/'/g, "''") : "");
      await this.db.exec(
        `INSERT OR REPLACE INTO images (id,product_id,cos_key,url,status,retry_count,dead_letter,local_path,error,created_at,updated_at) VALUES ('${record.id}','${record.productId}','${record.cosKey}','${esc(record.url)}','${record.status}',${record.retryCount},${record.deadLetter ? 1 : 0},${record.localPath ? "'" + esc(record.localPath) + "'" : "NULL"},${record.error ? "'" + esc(record.error) + "'" : "NULL"},'${record.createdAt}','${record.updatedAt}')`
      );
    } catch (error) {
      logger.error("[COS] DB record failed:", error);
    }
  }
}

// Re-export the ConcurrencyLimiter for other services to use
export { ConcurrencyLimiter };
