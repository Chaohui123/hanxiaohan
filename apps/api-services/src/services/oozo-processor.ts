// ============================================================
// Oozo Processor — watch D:\Oozo, process images & videos for Ozon
// Image: GLM Vision analysis → Russian selling-point overlay
// Video: DeepSeek script → Edge TTS voiceover → ffmpeg subtitles
// Output: modified/ folder + result.json for listing pipeline
// ============================================================

import { watch, readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, basename, dirname } from "node:path";
import { logger } from "@onzo/logger";

const WATCH_DIR = process.env.OOZO_WATCH_DIR || "D:/下载";
const POLL_INTERVAL_MS = 10_000; // Check every 10 seconds
const DEDUP_FILE = join(WATCH_DIR, ".oozo-dedup.json");

interface DedupEntry {
  fingerprint: string;
  folderName: string;
  status: string;
  lastSeen: string;
}

/**
 * Compute a fingerprint from a product's file list.
 * Same files = same fingerprint, regardless of folder name.
 */
function computeFingerprint(files: { images: string[]; videos: string[] }): string {
  const sorted = [
    ...files.images.map((f) => `img:${f}`),
    ...files.videos.map((f) => `vid:${f}`),
  ].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex").substring(0, 16);
}

/**
 * Load dedup database from disk.
 */
async function loadDedupDb(): Promise<Map<string, DedupEntry>> {
  try {
    if (existsSync(DEDUP_FILE)) {
      const raw = await readFile(DEDUP_FILE, "utf-8");
      const entries: DedupEntry[] = JSON.parse(raw);
      return new Map(entries.map((e) => [e.fingerprint, e]));
    }
  } catch { /* corrupted file — start fresh */ }
  return new Map();
}

/**
 * Save dedup database to disk.
 */
async function saveDedupDb(db: Map<string, DedupEntry>): Promise<void> {
  await writeFile(DEDUP_FILE, JSON.stringify([...db.values()], null, 2), "utf-8");
}

export interface OozoProduct {
  /** Folder name (product name from plugin) */
  folderName: string;
  /** Parsed product name from folder */
  productName: string;
  /** Fingerprint for dedup (content-based, not folder-name-based) */
  fingerprint: string;
  /** Whether this is a duplicate of an already-processed product */
  isDuplicate: boolean;
  /** Absolute paths */
  paths: {
    root: string;
    originalImages: string;
    originalVideos: string;
    modifiedImages: string;
    modifiedVideos: string;
    resultJson: string;
  };
  /** Original files found (relative paths like "主图/img001.jpg") */
  files: {
    images: string[];
    videos: string[];
  };
  /** CSV data parsed from 商品信息.csv */
  csvData: Record<string, string> | null;
  /** Processing status */
  status: "pending" | "processing" | "done" | "failed";
  error?: string;
  /** Results after processing */
  result?: {
    titleCn: string;
    titleRu: string;
    descriptionRu: string;
    imageCount: number;
    videoCount: number;
    processedAt: string;
    csvFields?: Record<string, string>;
  };
}

/**
 * Scan D:\Oozo for new product folders that haven't been processed yet.
 * A folder is "ready" when it has an original/ subdirectory with files
 * AND no result.json yet.
 */
export async function scanForNewProducts(): Promise<OozoProduct[]> {
  if (!existsSync(WATCH_DIR)) {
    await mkdir(WATCH_DIR, { recursive: true });
    logger.info({ dir: WATCH_DIR }, "Created Oozo watch directory");
    return [];
  }

  const dedupDb = await loadDedupDb();
  const entries = await readdir(WATCH_DIR, { withFileTypes: true });
  const products: OozoProduct[] = [];
  const duplicates: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden/metadata dirs
    if (entry.name.startsWith(".") || entry.name === "modified") continue;

    const root = join(WATCH_DIR, entry.name);
    const resultPath = join(root, "result.json");

    // Skip already processed (local result.json)
    if (existsSync(resultPath)) {
      const resultRaw = await readFile(resultPath, "utf-8").catch(() => "{}");
      const result = JSON.parse(resultRaw);
      if (result.status === "done") continue;
    }

    const product = await scanProductFolder(root, entry.name);
    if (product.files.images.length === 0 && product.files.videos.length === 0) continue;

    // Content-based dedup: same files = same product
    const existing = dedupDb.get(product.fingerprint);
    if (existing && existing.status === "done") {
      product.isDuplicate = true;
      duplicates.push(`${entry.name} → dup of ${existing.folderName}`);
      // Update lastSeen but don't re-process
      existing.lastSeen = new Date().toISOString();
      dedupDb.set(product.fingerprint, existing);
    } else {
      products.push(product);
    }
  }

  if (duplicates.length > 0) {
    logger.info({ duplicates }, "Oozo — skipped duplicate products");
  }
  if (dedupDb.size > 0) await saveDedupDb(dedupDb);

  return products;
}

/**
 * Scan a single product folder and return its file inventory.
 * Matches 1688 plugin layout: 主图/ 详情图/ SKU图/ 视频/ 商品信息.csv
 */
export async function scanProductFolder(root: string, folderName: string): Promise<OozoProduct> {
  // Product name is the folder name itself
  const productName = folderName;

  // Plugin export formats (auto-detect):
  // A) Directory-based: 主图/ 详情图/ SKU图/ 视频/ 商品信息.csv
  // B) Flat with prefixes: 主图-1.jpg, 详情-1.jpg, sku-1-xxx.jpg, 视频-1.mp4
  const imageDirs = ["主图", "详情图", "SKU图"];
  const videoDir = "视频";

  const paths = {
    root,
    originalImages: root,
    originalVideos: join(root, videoDir),
    modifiedImages: join(root, "modified", "images"),
    modifiedVideos: join(root, "modified", "videos"),
    resultJson: join(root, "result.json"),
  };

  for (const p of [paths.modifiedImages, paths.modifiedVideos]) {
    if (!existsSync(p)) await mkdir(p, { recursive: true }).catch(() => {});
  }

  // Detect format: check if subdirectories exist
  const hasDirectories = imageDirs.some((d) => {
    try { return existsSync(join(root, d)); } catch { return false; }
  });
  const hasFlatFiles = (() => {
    try {
      const files = readdirSync(root);
      return files.some((f) => /^(主图|详情|sku|视频)[-_]/.test(f));
    } catch { return false; }
  })();

  const imageFiles: string[] = [];
  const videoFiles: string[] = [];

  if (hasDirectories) {
    // Format A: 主图/, 详情图/, SKU图/ directories
    for (const dir of imageDirs) {
      const dirPath = join(root, dir);
      if (existsSync(dirPath)) {
        const files = (await readdir(dirPath))
          .filter((f) => /\.(jpg|jpeg|png|webp|bmp)$/i.test(f))
          .map((f) => `${dir}/${f}`);
        imageFiles.push(...files);
      }
    }
    if (existsSync(paths.originalVideos)) {
      (await readdir(paths.originalVideos))
        .filter((f) => /\.(mp4|mov|avi|webm|mkv)$/i.test(f))
        .forEach((f) => videoFiles.push(`${videoDir}/${f}`));
    }
  } else if (hasFlatFiles) {
    // Format B: flat files with naming prefixes
    const allFiles = await readdir(root);
    for (const f of allFiles) {
      const lower = f.toLowerCase();
      if (/\.(jpg|jpeg|png|webp|bmp)$/i.test(lower)) {
        if (/^(主图|详情|sku)[-_]/i.test(f)) imageFiles.push(f);
      } else if (/\.(mp4|mov|avi|webm|mkv)$/i.test(lower)) {
        if (/^视频[-_]/i.test(f)) videoFiles.push(f);
      }
    }
    // Sort: 主图 first (primary images for Ozon), then 详情, then sku
    imageFiles.sort((a, b) => {
      if (a.startsWith("主图") && !b.startsWith("主图")) return -1;
      if (!a.startsWith("主图") && b.startsWith("主图")) return 1;
      if (a.startsWith("详情") && b.startsWith("sku")) return -1;
      if (b.startsWith("详情") && a.startsWith("sku")) return 1;
      return a.localeCompare(b);
    });
  }

  // Parse 商品信息.csv or .xlsx if present
  let csvData: Record<string, string> | null = null;
  const csvFiles = (await readdir(root).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".csv") || f === "商品信息.csv"
  );
  for (const csvFile of csvFiles) {
    try {
      const csvRaw = await readFile(join(root, csvFile), "utf-8");
      const lines = csvRaw.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length >= 2) {
        const headers = lines[0].split(",").map((h) => h.trim());
        const values = lines[1].split(",").map((v) => v.trim());
        csvData = Object.fromEntries(headers.map((h, i) => [h, values[i] || ""]));
        break;
      }
    } catch { /* continue */ }
  }

  const files = { images: imageFiles, videos: videoFiles };
  return {
    folderName,
    productName,
    fingerprint: computeFingerprint(files),
    isDuplicate: false,
    paths,
    files,
    csvData,
    status: "pending",
  };
}

/**
 * Save processing result to result.json.
 */
export async function saveResult(product: OozoProduct): Promise<void> {
  const output = {
    folderName: product.folderName,
    productName: product.productName,
    fingerprint: product.fingerprint,
    status: product.status,
    error: product.error,
    result: product.result,
    files: product.files,
    paths: {
      modifiedImages: product.paths.modifiedImages,
      modifiedVideos: product.paths.modifiedVideos,
    },
  };
  await writeFile(product.paths.resultJson, JSON.stringify(output, null, 2), "utf-8");

  // Update dedup DB
  if (product.status === "done") {
    const dedupDb = await loadDedupDb();
    dedupDb.set(product.fingerprint, {
      fingerprint: product.fingerprint,
      folderName: product.folderName,
      status: product.status,
      lastSeen: new Date().toISOString(),
    });
    await saveDedupDb(dedupDb);
  }
}

/**
 * Start watching D:\Oozo. Calls onNewProduct for each unprocessed folder found.
 * Returns a stop function.
 */
export function startWatching(
  onNewProduct: (product: OozoProduct) => Promise<void>
): () => void {
  logger.info({ dir: WATCH_DIR }, "Oozo watcher started");

  let running = true;
  const seen = new Set<string>();

  async function poll() {
    if (!running) return;
    try {
      const products = await scanForNewProducts();
      for (const p of products) {
        if (!seen.has(p.folderName) && p.files.images.length + p.files.videos.length > 0) {
          seen.add(p.folderName);
          logger.info({ folder: p.folderName, images: p.files.images.length, videos: p.files.videos.length }, "Oozo — new product detected");
          await onNewProduct(p).catch((err) => {
            logger.error({ folder: p.folderName, err }, "Oozo processing failed");
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "Oozo watcher poll error");
    }
    if (running) setTimeout(poll, POLL_INTERVAL_MS);
  }

  poll();

  return () => {
    running = false;
    logger.info("Oozo watcher stopped");
  };
}
