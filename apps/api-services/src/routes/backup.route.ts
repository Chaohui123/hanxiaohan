// ============================================================
// Backup routes — SQLite db auto-backup with 7-day rotation
// ============================================================

import { Router } from "express";
import { copyFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const BACKUP_DIR = "./data/backups";
const MAX_BACKUP_DAYS = 7;

export function createBackupRouter(): Router {
  const router = Router();

  // POST /api/db/backup — trigger a manual backup
  router.post("/db/backup", async (req, res) => {
    try {
      const dbPath = process.env.SQLITE_DB_PATH || "./data/onzo.db";
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupName = `onzo-${ts}.db`;
      const backupPath = join(BACKUP_DIR, backupName);

      await mkdir(BACKUP_DIR, { recursive: true });
      await copyFile(dbPath, backupPath);

      // Rotate old backups (keep last 7 days)
      const files = await readdir(BACKUP_DIR);
      const dbFiles = files.filter((f) => f.endsWith(".db")).sort();
      while (dbFiles.length > MAX_BACKUP_DAYS) {
        const oldest = dbFiles.shift()!;
        await unlink(join(BACKUP_DIR, oldest));
      }

      res.json({
        success: true,
        data: { backup: backupName, retained: dbFiles.length },
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

  return router;
}
