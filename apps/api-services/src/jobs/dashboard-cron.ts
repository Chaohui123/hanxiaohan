// ============================================================
// Dashboard Cron — node-cron based daily scheduling
// 01:50 keyword pool scrape → 02:00 full dashboard analysis
// Integrates with bullmq for async job distribution.
// ============================================================

import { logger } from "@onzo/logger";

let cronMod: typeof import("node-cron") | null = null;
try {
  cronMod = await import("node-cron");
} catch { logger.warn("node-cron not installed — dashboard cron disabled"); }

import { getQueue, JobName } from "../services/bullmq-queue.js";

const ENABLED = process.env.DASHBOARD_CRON_ENABLE !== "false";

/**
 * Start the dashboard cron schedule.
 * - 01:50 daily: Scrape keyword pool from promo-agent
 * - 02:00 daily: Full dashboard analysis pipeline
 * - 08:00 daily: Store-wide price adjustment
 */
export function startDashboardCron(): void {
  if (!ENABLED) {
    logger.info("DashboardCron: disabled (DASHBOARD_CRON_ENABLE != true)");
    return;
  }

  const schedule = cronMod?.schedule;
  if (!schedule) {
    logger.warn("DashboardCron: node-cron unavailable — dashboard timer disabled");
    return;
  }

  // 01:50 — Keyword pool scrape
  schedule(process.env.KEYWORD_SCRAPE_CRON || "50 1 * * *", async () => {
    logger.info("DashboardCron: triggering keyword pool scrape (01:50)");
    try {
      const queue = await getQueue("daily-tasks");
      const job = await queue.add(JobName.KEYWORD_SCRAPE, {
        date: new Date().toISOString().slice(0, 10),
        source: "cron-0150",
      }, { priority: 1 });
      logger.info({ jobId: job.id }, "DashboardCron: keyword scrape job enqueued");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "DashboardCron: keyword scrape enqueue failed");
    }
  });

  // 02:00 — Full dashboard analysis
  schedule(process.env.MARKET_TASK_CRON || "0 2 * * *", async () => {
    logger.info("DashboardCron: triggering full dashboard analysis (02:00)");
    try {
      const queue = await getQueue("daily-tasks");
      const job = await queue.add(JobName.DASHBOARD_ANALYSIS, {
        date: new Date().toISOString().slice(0, 10),
        source: "cron-0200",
        includeModules: ["overview", "categories", "products", "keywords", "costs", "competitors", "pricing"],
      }, { priority: 2 });
      logger.info({ jobId: job.id }, "DashboardCron: dashboard analysis job enqueued");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "DashboardCron: dashboard enqueue failed");
    }
  });

  // 22:00 — Daily report generation
  schedule(process.env.REPORT_CRON || "0 22 * * *", async () => {
    logger.info("DashboardCron: triggering daily report generation (22:00)");
    try {
      const queue = await getQueue("daily-tasks");
      await queue.add(JobName.DASHBOARD_REPORT, {
        date: new Date().toISOString().slice(0, 10),
        source: "cron-2200",
      }, { priority: 3 });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "DashboardCron: report enqueue failed");
    }
  });

  logger.info("DashboardCron: cron jobs registered (01:50 keyword, 02:00 dashboard, 22:00 report)");
}
