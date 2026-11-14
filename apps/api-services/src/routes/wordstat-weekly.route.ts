import { Router, type Response } from "express";
import { YandexCloudClient, YandexCloudError } from "@onzo/yandex-cloud";
import { getDb } from "../db/connection.js";
import type { DbAdapter } from "../db/connection.js";
import { latestWordstatWeekly, syncWordstatWeekly } from "../services/wordstat-weekly.js";

interface WordstatWeeklyRouterOptions {
  client?: YandexCloudClient;
  db?: DbAdapter;
  notify?: (card: Record<string, unknown>, correlationId: string) => Promise<boolean>;
}

export function createWordstatWeeklyRouter(options: WordstatWeeklyRouterOptions = {}): Router {
  const router = Router();
  const client = options.client || new YandexCloudClient();
  const resolveDb = async (): Promise<DbAdapter> => {
    const database = options.db || await getDb();
    if (!database) throw new Error("Wordstat weekly database is unavailable");
    return database;
  };

  router.get("/yandex-cloud/wordstat/weekly/latest", async (_req, res) => {
    try {
      res.json({ success: true, data: await latestWordstatWeekly(await resolveDb(), client) });
    } catch (error) { sendError(res, error); }
  });

  const sync = async (dryRun: boolean, res: Response) => {
    try {
      const result = await syncWordstatWeekly({
        client,
        db: await resolveDb(),
        dryRun,
        ...(options.notify ? { notify: options.notify } : {}),
      });
      res.json({ success: true, data: result });
    } catch (error) { sendError(res, error); }
  };
  router.post("/yandex-cloud/wordstat/weekly/sync", async (req, res) => { await sync(req.body?.dryRun === true, res); });
  router.post("/yandex-cloud/wordstat/weekly/preview", async (_req, res) => { await sync(true, res); });
  return router;
}

function sendError(res: Response, error: unknown): void {
  const status = error instanceof YandexCloudError ? error.status : 400;
  res.status(status).json({
    success: false,
    error: {
      code: error instanceof YandexCloudError ? "YANDEX_API_ERROR" : "WORDSTAT_WEEKLY_ERROR",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    },
  });
}
