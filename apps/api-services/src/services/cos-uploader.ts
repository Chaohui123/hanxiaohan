// ============================================================
// COS (Tencent Cloud Object Storage) Image Uploader
// Stores product images to COS and returns public URLs for Ozon import
// ============================================================

import COS from "cos-nodejs-sdk-v5";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";

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

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000];

export class CosUploader {
  private cos: COS;
  private bucket: string;
  private region: string;
  private baseUrl: string;
  private deadLetterDir: string;
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
    if (!existsSync(this.deadLetterDir)) {
      mkdirSync(this.deadLetterDir, { recursive: true });
    }
  }

  async uploadImage(filePath: string, productId: string, customKey?: string): Promise<UploadResult> {
    const ext = extname(filePath) || ".jpg";
    const hash = createHash("md5").update(readFileSync(filePath)).digest("hex").substring(0, 12);
    const cosKey = customKey || `products/${productId}/${hash}${ext}`;

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
        console.error(`[COS] Upload failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${cosKey} - ${errMsg}`);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        return this.saveToDeadLetter(filePath, productId, cosKey, errMsg);
      }
    }
    return { success: false, error: "Max retries exceeded" };
  }

  async uploadImagesBatch(files: Array<{ filePath: string; productId: string; key?: string }>): Promise<UploadResult[]> {
    const results = await Promise.allSettled(files.map((f) => this.uploadImage(f.filePath, f.productId, f.key)));
    return results.map((r) => {
      if (r.status === "fulfilled") return r.value;
      return { success: false, error: r.reason?.message || "Unknown error", isDeadLetter: false };
    });
  }

  getImageUrl(cosKey: string): string {
    return `${this.baseUrl}/${cosKey}`;
  }

  async deleteImage(cosKey: string): Promise<boolean> {
    try {
      await this.cosDelete(cosKey);
      return true;
    } catch (error) {
      console.error(`[COS] Delete failed: ${cosKey}`, error);
      return false;
    }
  }

  async retryDeadLetterImages(): Promise<UploadResult[]> {
    const deadLetterFiles = this.getDeadLetterFiles();
    const results: UploadResult[] = [];
    for (const file of deadLetterFiles) {
      try {
        const meta = this.readDeadLetterMeta(file);
        if (!meta) continue;
        const result = await this.uploadImage(meta.filePath, meta.productId, meta.cosKey);
        results.push(result);
        if (result.success) this.removeDeadLetterFile(file);
      } catch (error) {
        results.push({ success: false, error: error instanceof Error ? error.message : String(error), isDeadLetter: true });
      }
    }
    return results;
  }

  private cosUpload(filePath: string, key: string): Promise<COS.PutObjectResult> {
    return new Promise((resolve, reject) => {
      this.cos.uploadFile({ Bucket: this.bucket, Region: this.region, Key: key, FilePath: filePath }, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  private cosDelete(key: string): Promise<COS.DeleteObjectResult> {
    return new Promise((resolve, reject) => {
      this.cos.deleteObject({ Bucket: this.bucket, Region: this.region, Key: key }, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  private async saveToDeadLetter(filePath: string, productId: string, cosKey: string, error: string): Promise<UploadResult> {
    const fileName = `${productId}_${createHash("md5").update(cosKey).digest("hex").substring(0, 8)}${extname(filePath)}`;
    const localPath = join(this.deadLetterDir, fileName);
    try {
      writeFileSync(localPath, readFileSync(filePath));
      writeFileSync(`${localPath}.meta.json`, JSON.stringify({ productId, cosKey, originalPath: filePath, error, savedAt: new Date().toISOString() }));
      await this.recordUpload({
        id: randomUUID(), productId, cosKey, url: "",
        status: "dead_letter", retryCount: MAX_RETRIES, deadLetter: true,
        localPath, error, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    } catch (dlError) {
      console.error("[COS] Dead letter save also failed:", dlError);
    }
    return { success: false, isDeadLetter: true, error, cosKey };
  }

  private getDeadLetterFiles(): string[] {
    if (!existsSync(this.deadLetterDir)) return [];
    return readdirSync(this.deadLetterDir).filter((f) => f.endsWith(".meta.json")).map((f) => join(this.deadLetterDir, f));
  }

  private readDeadLetterMeta(metaPath: string): { filePath: string; productId: string; cosKey: string } | null {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const imagePath = metaPath.replace(".meta.json", "");
      if (existsSync(imagePath)) return { filePath: imagePath, productId: meta.productId, cosKey: meta.cosKey };
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
      console.error("[COS] DB record failed:", error);
    }
  }
}
