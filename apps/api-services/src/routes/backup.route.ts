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

    const fileStat = await stat(backupPath).catch(() => null);
    if (!fileStat) {
      console.error("[Backup] Backup file not created");
      return null;
    }

    console.log(`[Backup] Created: ${backupName} (${(fileStat.size / 1024).toFixed(1)} KB)`);
    return { name: backupName, path: backupPath, sizeBytes: fileStat.size };
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
  const write = (s: string) => new Promise<void>((r) => { output.write(s, () => r()); });

  try {
    for (const table of tables) {
      await write(`-- ONZO backup: ${table}\n`);
      const rows = await db.all(`SELECT * FROM ${table}`).catch(() => [] as Record<string, unknown>[]);
      for (const row of rows) {
        const cols = Object.keys(row).join(", ");
        const vals = Object.values(row).map((v) =>
          v === null ? "NULL" : typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v)
        ).join(", ");
        await write(`INSERT INTO ${table} (${cols}) VALUES (${vals});\n`);
      }
      await write("\n");
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
 * Rotate old backups, keeping only the most recent N.
 */
async function rotateBackups(): Promise<void> {
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const files = await readdir(BACKUP_DIR);
    const backupFiles = files
      .filter((f) => f.startsWith("onzo-") && f.endsWith(".sql.gz"))
      .sort()
      .reverse();

    const cutoff = Date.now() - MAX_BACKUP_DAYS * 24 * 60 * 60 * 1000;
    for (const file of backupFiles.slice(MAX_BACKUP_DAYS)) {
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
        .filter((f) => f.startsWith("onzo-") && f.endsWith(".sql.gz"))
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
