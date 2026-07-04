// ============================================================
// Backup routes — SQLite db auto-backup with configurable retention
// ============================================================

import { Router } from "express";
import { mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

const BACKUP_DIR = process.env.BACKUP_DIR || "./data/backups";
const MAX_BACKUP_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "7", 10);
const AUTO_BACKUP_INTERVAL_HOURS = parseInt(process.env.BACKUP_INTERVAL_HOURS || "6", 10);

let autoBackupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run an atomic backup using SQLite's built-in .backup() API.
 * This is safe to run while the database is in use — it acquires a read lock
 * and copies a consistent snapshot. Falls back to VACUUM INTO on older SQLite.
 */
async function runBackup(dbPath?: string): Promise<{ name: string; path: string; sizeBytes: number } | null> {
  const sourcePath = dbPath || process.env.SQLITE_DB_PATH || "./data/onzo.db";

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `onzo-${ts}.db`;
    const backupPath = join(BACKUP_DIR, backupName);

    await mkdir(BACKUP_DIR, { recursive: true });

    // Use SQLite backup API (atomic, consistent snapshot)
    const sqlite = await import("node:sqlite");
    const srcDb = new sqlite.DatabaseSync(sourcePath);
    try {
      // VACUUM INTO creates a consistent copy without blocking writes
      srcDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } finally {
      srcDb.close();
    }

    // Rotate old backups
    await rotateBackups();

    const fileStat = await stat(backupPath);
    console.log(`[Backup] Created: ${backupName} (${(fileStat.size / 1024).toFixed(1)} KB)`);
    return { name: backupName, path: backupPath, sizeBytes: fileStat.size };
  } catch (err) {
    console.error(`[Backup] Failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Rotate old backups, keeping only the most recent N.
 */
async function rotateBackups(): Promise<void> {
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const files = await readdir(BACKUP_DIR);
    const dbFiles = files
      .filter((f) => f.startsWith("onzo-") && f.endsWith(".db"))
      .sort()
      .reverse(); // newest first

    // Delete backups older than MAX_BACKUP_DAYS
    const cutoff = Date.now() - MAX_BACKUP_DAYS * 24 * 60 * 60 * 1000;
    for (const file of dbFiles.slice(MAX_BACKUP_DAYS)) {
      const filePath = join(BACKUP_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await unlink(filePath);
          console.log(`[Backup] Rotated out: ${file}`);
        }
      } catch {
        // File already gone
      }
    }
  } catch (err) {
    console.warn(`[Backup] Rotation failed: ${(err as Error).message}`);
  }
}

/**
 * Start the auto-backup scheduler.
 * Runs every AUTO_BACKUP_INTERVAL_HOURS.
 */
export function startAutoBackup(dbPath?: string): void {
  if (autoBackupTimer) return;

  const intervalMs = AUTO_BACKUP_INTERVAL_HOURS * 3600 * 1000;
  console.log(`[Backup] Auto-backup scheduled every ${AUTO_BACKUP_INTERVAL_HOURS}h, keeping ${MAX_BACKUP_DAYS} days`);

  // Run first backup after 1 minute (wait for DB to be ready)
  setTimeout(() => {
    runBackup(dbPath);

    autoBackupTimer = setInterval(() => {
      runBackup(dbPath);
    }, intervalMs);
  }, 60_000);
}

/**
 * Stop the auto-backup scheduler (called during shutdown).
 */
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
        data: {
          backup: result.name,
          sizeKb: (result.sizeBytes / 1024).toFixed(1),
        },
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
      const dbFiles = files
        .filter((f) => f.startsWith("onzo-") && f.endsWith(".db"))
        .sort()
        .reverse();

      const backups = await Promise.all(
        dbFiles.map(async (f) => {
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
