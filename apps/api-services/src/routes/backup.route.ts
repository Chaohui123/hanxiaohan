// ============================================================
// Backup routes — PostgreSQL auto-backup via pg_dump + gzip
// ============================================================

import { Router } from "express";
import { mkdir, readdir, unlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { logger } from "@onzo/logger";

const BACKUP_DIR = process.env.BACKUP_DIR || "./data/backups";
const MAX_BACKUP_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "7", 10);
const AUTO_BACKUP_INTERVAL_HOURS = parseInt(process.env.BACKUP_INTERVAL_HOURS || "6", 10);

let autoBackupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a PostgreSQL backup using pg_dump → gzip.
 * Falls back to key-table SELECT export if pg_dump is unavailable.
 */
async function runBackup(): Promise<{ name: string; path: string; sizeBytes: number } | null> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `onzo-${ts}.sql.gz`;
    const backupPath = join(BACKUP_DIR, backupName);

    await mkdir(BACKUP_DIR, { recursive: true });

    const dbUrl = process.env.DATABASE_URL || "postgresql://onzo:onzo@localhost:5432/onzo_prod";

    // Try pg_dump (primary method)
    const pgDumpSuccess = await tryPgDump(dbUrl, backupPath);
    if (!pgDumpSuccess) {
      // Fallback: export key tables via pg connection
      await fallbackExport(backupPath);
    }

    await rotateBackups();

    // Encrypt backup if ENCRYPTION_KEY is configured (protects buyer data in raw_json)
    const finalPath = await encryptBackup(backupPath);

    // Upload to remote storage if RCLONE_REMOTE is configured
    await uploadToRemote(finalPath);

    const finalName = finalPath.split("/").pop() || backupName;
    const fileStat = await stat(finalPath).catch(() => null);
    if (!fileStat) {
      logger.error("[Backup] Backup file not created");
      return null;
    }

    logger.info(`[Backup] Created: ${finalName} (${(fileStat.size / 1024).toFixed(1)} KB)`);
    return { name: finalName, path: finalPath, sizeBytes: fileStat.size };
  } catch (err) {
    console.error(`[Backup] Failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Try pg_dump for a full PostgreSQL backup.
 */
function tryPgDump(dbUrl: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const gzip = createGzip();
    const output = createWriteStream(outputPath);

    execFile(
      "pg_dump",
      ["--no-owner", "--no-privileges", "--compress=0", dbUrl],
      { timeout: 120_000 },
      (err) => {
        if (err) {
          console.warn(`[Backup] pg_dump unavailable: ${err.message} — falling back to table export`);
          resolve(false);
        } else {
          resolve(true);
        }
      }
    ).stdout?.pipe(gzip).pipe(output);
  });
}

/**
 * Fallback: export key tables as SQL via pg Pool SELECT queries.
 */
async function fallbackExport(outputPath: string): Promise<void> {
  const { getDb } = await import("../db/connection.js");
  const db = await getDb().catch(() => null);
  if (!db) return;

  const tables = [
    "task_queue", "failed_tasks", "listing_records", "local_orders",
    "webhook_events", "inventory", "stock_movements", "token_usage",
    "store_configs", "category_cache", "stock_alerts", "aftersales_cases",
    "daily_sales", "product_performance", "images",
  ];

  const gzip = createGzip();
  const output = createWriteStream(outputPath);
  // Fallback: export key tables as JSON Lines via parameterized SELECT queries.
  // JSONL is safer than SQL INSERT dumps (no escaping issues, no injection risk).
  // Restore: parse each JSON line and execute parameterized INSERT via db.run().
  const write = (s: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (!output.write(s)) {
        output.once("drain", resolve);
      } else {
        resolve();
      }
      output.once("error", reject);
    });

  try {
    for (const table of tables) {
      const rows = await db
        .all(`SELECT * FROM ${table}`)
        .catch(() => [] as Record<string, unknown>[]);

      for (const row of rows) {
        await write(JSON.stringify({ __table: table, ...row }) + "\n");
      }
    }
    await new Promise<void>((resolve, reject) => {
      gzip.end();
      gzip.on("finish", resolve);
      gzip.on("error", reject);
    });
  } finally {
    output.close();
  }
}

/**
 * Encrypt backup file with AES-256-GCM if ENCRYPTION_KEY is configured.
 * Backups may contain sensitive buyer data (raw_json includes phone numbers, addresses).
 */
async function encryptBackup(inputPath: string): Promise<string> {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey || encKey.startsWith("CHANGE_ME")) return inputPath;

  const crypto = await import("node:crypto");
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");

  const encPath = inputPath + ".enc";
  const key = crypto.scryptSync(encKey, "onzo-backup-salt", 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const input = createReadStream(inputPath);
  const output = createWriteStream(encPath);
  output.write(iv); // prepend IV for decryption

  await pipeline(input, cipher, output);
  const tag = cipher.getAuthTag();
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(encPath, { flags: "a" });
    ws.end(tag, () => resolve());
    ws.on("error", reject);
  });

  // Remove unencrypted original
  const { unlink } = await import("node:fs/promises");
  await unlink(inputPath).catch(() => {});

  return encPath;
}

/**
 * Upload backup to remote storage via rclone if RCLONE_REMOTE is configured.
 */
async function uploadToRemote(backupPath: string): Promise<boolean> {
  const rcloneRemote = process.env.RCLONE_REMOTE;
  if (!rcloneRemote || rcloneRemote.includes("CHANGE_ME")) return false;

  try {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "rclone",
        ["copyto", backupPath, `${rcloneRemote}/backups/${backupPath.split("/").pop()}`],
        { timeout: 300_000 },
        (err) => (err ? reject(err) : resolve())
      );
    });
    logger.info({ remote: rcloneRemote, file: backupPath.split("/").pop() }, "Backup uploaded to remote storage");
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Remote backup upload failed — rclone not configured or unreachable");
    return false;
  }
}

/**
 * Rotate old backups, keeping only the most recent N.
 */
async function rotateBackups(): Promise<void> {
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const files = await readdir(BACKUP_DIR);
    const backupFiles = files
      .filter((f) => f.startsWith("onzo-") && (f.endsWith(".sql.gz") || f.endsWith(".sql.gz.enc")))
      .sort()
      .reverse();

    const cutoff = Date.now() - MAX_BACKUP_DAYS * 24 * 60 * 60 * 1000;
    for (const file of backupFiles) {
      const fileMtime = (await stat(join(BACKUP_DIR, file)).catch(() => null))?.mtimeMs;
      if (fileMtime && fileMtime > cutoff) continue;
      const filePath = join(BACKUP_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await unlink(filePath);
          console.log(`[Backup] Rotated out: ${file}`);
        }
      } catch { /* already gone */ }
    }
  } catch (err) {
    console.warn(`[Backup] Rotation failed: ${(err as Error).message}`);
  }
}

export function startAutoBackup(): void {
  if (autoBackupTimer) return;

  const intervalMs = AUTO_BACKUP_INTERVAL_HOURS * 3600 * 1000;
  console.log(`[Backup] Auto-backup scheduled every ${AUTO_BACKUP_INTERVAL_HOURS}h, keeping ${MAX_BACKUP_DAYS} days`);

  setTimeout(() => {
    runBackup();
    autoBackupTimer = setInterval(() => runBackup(), intervalMs);
  }, 60_000);
}

export function stopAutoBackup(): void {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer);
    autoBackupTimer = null;
    console.log("[Backup] Auto-backup stopped");
  }
}

export function createBackupRouter(): Router {
  const router = Router();

  // POST /api/db/backup — trigger a manual backup
  router.post("/db/backup", async (req, res) => {
    try {
      const result = await runBackup();
      if (!result) {
        res.status(500).json({
          success: false,
          error: { code: "BACKUP_FAILED", message: "Backup failed — check server logs" },
          correlationId: req.correlationId,
        });
        return;
      }

      res.json({
        success: true,
        data: { backup: result.name, sizeKb: (result.sizeBytes / 1024).toFixed(1) },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "BACKUP_FAILED", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  // GET /api/db/backups — list existing backups
  router.get("/db/backups", async (req, res) => {
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      const files = await readdir(BACKUP_DIR);
      const backupFiles = files
        .filter((f) => f.startsWith("onzo-") && (f.endsWith(".sql.gz") || f.endsWith(".sql.gz.enc")))
        .sort()
        .reverse();

      const backups = await Promise.all(
        backupFiles.map(async (f) => {
          const s = await stat(join(BACKUP_DIR, f)).catch(() => null);
          return {
            name: f,
            sizeKb: s ? (s.size / 1024).toFixed(1) : "?",
            createdAt: s ? s.mtime.toISOString() : "unknown",
          };
        })
      );

      res.json({
        success: true,
        data: { count: backups.length, retentionDays: MAX_BACKUP_DAYS, directory: BACKUP_DIR, backups },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "LIST_BACKUPS_FAILED", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}
