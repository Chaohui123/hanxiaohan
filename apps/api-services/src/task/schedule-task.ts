// ============================================================
// Daily Scheduled Tasks — cron-based automation
// 02:00 大盘轮询+自动上架
// 08:00 全店商品调价
// Falls back gracefully if node-cron is not installed
// ============================================================

import { logger } from "@onzo/logger";

let cronMod: typeof import("node-cron") | null = null;
try {
  cronMod = await import("node-cron");
} catch { logger.warn("node-cron not installed — scheduled tasks disabled"); }

import { executeDailyMarketPoll } from "../langgraph/daily-market-graph.js";
import { executeDailyPriceAdjust } from "../langgraph/daily-price-graph.js";

const ENABLED = process.env.TASK_SCHEDULE_ENABLE !== "false";

// ---- Execution log (in-memory) ----
export interface TaskLog {
  id: string;
  type: "market_poll" | "price_adjust" | "manual";
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  summary: string;
  details?: Record<string, unknown>;
}

export const taskLogs: TaskLog[] = [];
const MAX_LOGS = 50;

function addLog(type: TaskLog["type"]): TaskLog {
  const log: TaskLog = {
    id: `task_${Date.now()}`,
    type,
    startedAt: new Date().toISOString(),
    status: "running",
    summary: "",
  };
  taskLogs.unshift(log);
  if (taskLogs.length > MAX_LOGS) taskLogs.pop();
  return log;
}

function completeLog(log: TaskLog, success: boolean, summary: string, details?: Record<string, unknown>) {
  log.completedAt = new Date().toISOString();
  log.status = success ? "completed" : "failed";
  log.summary = summary;
  log.details = details;
}

// ---- Market Poll (02:00 daily) ----
async function runMarketPoll(): Promise<void> {
  const log = addLog("market_poll");
  logger.info("ScheduledTask: starting daily market poll + auto-list");

  try {
    const result = await executeDailyMarketPoll();
    const listed = (result as { listedCount?: number }).listedCount || 0;
    const msg = `大盘分析完成，自动上架 ${listed} 个商品`;
    completeLog(log, true, msg, {
      listedCount: listed,
      snapshotId: (result as { snapshotId?: string }).snapshotId || "",
      errors: (result as { errors?: string[] }).errors || [],
    });
    logger.info(msg);
  } catch (err) {
    const msg = `大盘轮询失败: ${(err as Error).message}`;
    completeLog(log, false, msg);
    logger.error(msg);
  }
}

// ---- Price Adjust (08:00 daily) ----
async function runPriceAdjust(): Promise<void> {
  const log = addLog("price_adjust");
  logger.info("ScheduledTask: starting daily price adjustment");

  try {
    const result = await executeDailyPriceAdjust();
    const adjusted = (result as { adjustedCount?: number }).adjustedCount || 0;
    const msg = `全店调价完成，调整 ${adjusted} 个商品`;
    completeLog(log, true, msg, {
      adjustedCount: adjusted,
      details: (result as { report?: Array<{ id: string; oldPrice: number; newPrice: number }> }).report || [],
    });
    logger.info(msg);
  } catch (err) {
    const msg = `调价失败: ${(err as Error).message}`;
    completeLog(log, false, msg);
    logger.error(msg);
  }
}

// ---- Public triggers (for API) ----
export async function triggerMarketPoll(): Promise<TaskLog> {
  const log = addLog("manual");
  log.type = "market_poll";
  await runMarketPoll();
  return log;
}

export async function triggerPriceAdjust(): Promise<TaskLog> {
  const log = addLog("manual");
  log.type = "price_adjust";
  await runPriceAdjust();
  return log;
}

// ---- Start scheduler ----
export function startScheduledTasks(): void {
  if (!ENABLED) {
    logger.info("ScheduledTask: disabled (TASK_SCHEDULE_ENABLE != true)");
    return;
  }

  const schedule = cronMod?.schedule;
  if (!schedule) {
    logger.warn("ScheduledTask: cron unavailable, tasks will not run on schedule");
    return;
  }

  // Daily market poll: 02:00
  schedule(process.env.MARKET_TASK_CRON || "0 2 * * *", () => {
    runMarketPoll().catch(() => {});
  });

  // Daily price adjust: 08:00
  schedule(process.env.PRICE_TASK_CRON || "0 8 * * *", () => {
    runPriceAdjust().catch(() => {});
  });

  logger.info("ScheduledTask: cron jobs registered (02:00 market, 08:00 price)");
}
