// ============================================================
// Scheduled job registration — all registerJob calls centralized
// Extracted from index.ts to keep the entrypoint lean.
// ============================================================

import { registerJob } from "../services/scheduler.js";
import type { AppConfig } from "../config.js";
import type { TaskQueue } from "../db/task-queue.js";
import type { ListingInfra } from "../services/listing-runner.js";

// Internal deps — lightweight types to avoid circular imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OzonClientLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TokenTrackerLike = any;

interface LoggerLike {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface CoreJobDeps {
  db: DrizzleLike | null;
  ozonClient: OzonClientLike;
  tokenTracker: TokenTrackerLike;
  logger: LoggerLike;
  config: AppConfig;
  taskQueue: TaskQueue;
  listingInfra: ListingInfra;
}

/**
 * Register core scheduled jobs that always run.
 * Must be called AFTER ozonClient and tokenTracker are initialized
 * but BEFORE startScheduler().
 */
export function registerCoreJobs(deps: CoreJobDeps): void {
  const { db, ozonClient, tokenTracker, logger, config, taskQueue, listingInfra } = deps;

  // OzonOrderSync flap 防护：连续失败周期计数（跨境抖动单次失败不告警）
  let syncFailStreak = 0;

  // Event-driven order flow: webhook is the primary channel.
  // This 6h job is only a deep-reconciliation fallback (was 30min polling).
  registerJob("order-sync", 6 * 3600_000, async () => {
    const { syncOrders } = await import("@onzo/ozon-order");
    await syncOrders(ozonClient as never, { storeId: "store_1", pageSize: 50 }).catch((err) =>
      logger.error({ err }, "Scheduled order sync failed")
    );
  });

  // Async webhook consumer — drains ozon_webhook_log every 30s so all
  // business logic stays out of the HTTP request path (receiver acks 200 instantly)
  registerJob("webhook-event-drain", 30_000, async () => {
    const { drainOzonWebhookLog } = await import("../services/webhook-drain.js");
    await drainOzonWebhookLog().catch((err) =>
      logger.error({ err: (err as Error).message }, "Webhook drain cycle failed")
    );
  });

  registerJob("import-status-sync", 15 * 60_000, async () => {
    const { syncImportStatuses } = await import("../services/import-status-sync.js");
    await syncImportStatuses(ozonClient as never).catch((err) =>
      logger.error({ err: (err as Error).message }, "Import status sync failed")
    );
  });

  registerJob("auto-ship", 3 * 3600_000, async () => {
    const { batchShipOrders } = await import("../services/auto-ship.js");
    await batchShipOrders(ozonClient as never).catch((err) =>
      logger.error({ err }, "Scheduled auto-ship failed")
    );
  });

  registerJob("review-sync", 3600_000, async () => {
    const { syncReviewStatuses } = await import("../services/review-sync.js");
    await syncReviewStatuses(ozonClient as never).catch((err) =>
      logger.error({ err }, "Scheduled review sync failed")
    );
  });

  registerJob("exchange-rate-refresh", 3600_000, async () => {
    const { forceRefreshRate } = await import("../services/exchange-rate.js");
    forceRefreshRate();
  });

  // 定期清理内存队列中已完结任务 — prune 定义了但无人调用，done/failed 任务在
  // 常驻进程里无界累积（2026-09-04 审查实证）
  registerJob("task-queue-prune", 6 * 3600_000, async () => {
    const pruned = taskQueue.prune(24);
    if (pruned > 0) logger.info({ pruned }, "Task queue pruned");
  });

  registerJob("market-data-collect", 24 * 3600_000, async () => {
    const { collectMarketData } = await import("../services/market-data-collector.js");
    await collectMarketData([], ozonClient as never).catch((err) =>
      logger.error({ err }, "Scheduled market data collection failed")
    );
  });

  registerJob("token-monitor", 6 * 3600_000, async () => {
    const used = tokenTracker.getTodayUsage();
    const limit = parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10);
    const remainingPercent = limit > 0 ? Math.round((1 - used / limit) * 100) : 100;

    logger.info({ usedTokens: used, dailyLimit: limit, remainingPercent }, "LLM token usage report");

    if (limit > 0 && used >= limit) {
      const { emitEvent } = await import("../services/notification-events.js");
      await emitEvent("TOKEN_LIMIT_REACHED", {
        used: String(used), limit: String(limit),
        percent: String(Math.round((used / limit) * 100)),
      });
    } else if (limit > 0 && used >= limit * 0.9) {
      logger.warn({
        usedTokens: used, dailyLimit: limit, remaining: limit - used,
      }, "LLM token limit approaching — reduce AI usage or increase LLM_DAILY_TOKEN_LIMIT");
    }
  });

  registerJob("data-consistency-check", 6 * 3600_000, async () => {
    const { getDb } = await import("../db/connection.js");
    const checkDb = await getDb().catch(() => null) as DrizzleLike | null;
    const { emitEvent } = await import("../services/notification-events.js");

    // 1. Order count mismatch — local vs Ozon (last 24h)
    try {
      const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
      const localRows = (await checkDb?.all(
        "SELECT COUNT(*) as cnt FROM local_orders WHERE created_at >= ?", [yesterday]
      ).catch(() => [])) as Array<{ cnt: number }>;
      const localCount: number = localRows?.[0]?.cnt ?? -1;

      let ozonCount: number = -1;
      try {
        // 本地 local_orders 同步 FBS+FBO 两种订单 — Ozon 侧必须同口径求和；
        // 只查 FBO 时 FBS 店铺 ozonCount≈0，偏差检查形同虚设（2026-09-04 审查实证）
        const [fbsResp, fboResp] = await Promise.all([
          ozonClient.request("POST", "/v3/posting/fbs/list", { filter: { since: yesterday }, limit: 1, offset: 0 }) as Promise<{ result?: { count?: number } }>,
          ozonClient.request("POST", "/v3/posting/fbo/list", { filter: { since: yesterday }, limit: 1, offset: 0 }) as Promise<{ result?: { count?: number } }>,
        ]);
        ozonCount = (fbsResp.result?.count ?? 0) + (fboResp.result?.count ?? 0);
      } catch { /* Ozon API unavailable */ }

      if (localCount >= 0 && ozonCount >= 0) {
        const diff = Math.abs(localCount - ozonCount);
        const deviationPct = ozonCount > 0 ? Math.round((diff / ozonCount) * 100) : 0;
        if (deviationPct > 5) {
          logger.warn({ localCount, ozonCount, deviationPct }, "Order count mismatch detected");
          await emitEvent("ORDER_SYNC_MISMATCH", {
            deviationPct: String(deviationPct), localCount: String(localCount), ozonCount: String(ozonCount),
          });
        } else {
          logger.info({ localCount, ozonCount, deviationPct }, "Order counts consistent");
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Order consistency check failed");
    }

    // 2. Inventory stock sync difference
    try {
      const invRows = await checkDb?.all(
        "SELECT offer_id, sku, stock_available FROM inventory WHERE stock_available > 0 LIMIT 100"
      ).catch(() => [] as Array<{ offer_id: string; sku: number; stock_available: number }>);
      if (invRows && invRows.length > 0) {
        try {
          // /v3/product/info/stocks 已 404 下线；查询库存用 v4（2026-08 实测）
          // v4 响应为顶层 items[]，库存明细在 items[].stocks[]（present/sku/type）
          const stocksResp = await ozonClient.request(
            "POST", "/v4/product/info/stocks",
            { filter: { offer_id: invRows.map((r: { offer_id: string }) => r.offer_id), visibility: "ALL" } }
          ) as { items?: Array<{ offer_id: string; stocks?: Array<{ sku: number; present: number }> }> };
          const ozonStocks = new Map<string, number>();
          for (const item of stocksResp.items || []) {
            for (const st of item.stocks || []) {
              const key = `${item.offer_id}:${st.sku}`;
              ozonStocks.set(key, (ozonStocks.get(key) ?? 0) + (Number(st.present) || 0));
            }
          }
          const diffs: string[] = [];
          for (const r of invRows) {
            const ozonStock = ozonStocks.get(`${r.offer_id}:${r.sku}`);
            if (ozonStock !== undefined && ozonStock !== r.stock_available) {
              diffs.push(`${r.offer_id}:${r.sku} local=${r.stock_available} ozon=${ozonStock}`);
            }
          }
          if (diffs.length > 0) {
            logger.warn({ diffCount: diffs.length, diffs: diffs.slice(0, 20) }, "Inventory stock mismatch");
          }
        } catch { /* Ozon stocks API unavailable */ }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Inventory consistency check failed");
    }

    // 3. Dead letter queue backlog
    try {
      const { readdir } = await import("node:fs/promises");
      const dlDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
      const files = await readdir(dlDir).catch(() => [] as string[]);
      if (files.length > 20) {
        await emitEvent("DEAD_LETTER_FULL", { count: String(files.length), category: "consistency-check" });
      }
    } catch { /* dead-letter dir not accessible */ }
  });

  registerJob("finance-reconcile", 24 * 3600_000, async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600_000);
    const dateFrom = yesterday.toISOString().slice(0, 10);
    const dateTo = now.toISOString().slice(0, 10);

    const { reconcileFinance } = await import("../services/finance-reconciler.js");
    const result = await reconcileFinance(ozonClient as never, dateFrom, dateTo);

    logger.info({
      job: "finance-reconcile", dateFrom, dateTo,
      totalOrders: result.totalOrders, matched: result.matched,
      discrepancies: result.discrepancies.length,
      missingLocal: result.missingLocal, missingOzon: result.missingOzon,
    }, "Daily finance reconciliation complete");

    if (result.discrepancies.length > 0) {
      logger.warn({ discrepancies: result.discrepancies.slice(0, 10) }, "Finance discrepancies detected — review required");
    }
  });

  // Ozon Order Sync v2 — every 5 minutes, with Redis distributed lock
  // flap 防护计数器：连续失败周期数（见下）
  registerJob("ozon-order-sync-v2", 5 * 60_000, async () => {
    if (!db) { logger.warn("OzonOrderSync: DB unavailable, skipping cycle"); return; }
    const { OzonOrderSyncService } = await import("../services/ozon-order-sync.js");
    const { acquireLock, releaseLock } = await import("../services/redis-lock.js");
    const lockToken = await acquireLock("global", 300);
    if (!lockToken) { logger.info("OzonOrderSync: Global lock held by another instance, skipping"); return; }
    try {
      const service = new OzonOrderSyncService(db as never);
      const result = await service.syncAllStores();
      logger.info({ ...result }, "OzonOrderSync: Scheduled sync completed");
      // flap 防护：跨境链路（服务器→俄罗斯）间歇超时属正常抖动——连续 3 个周期失败才告警
      // （9/1 实证：单次 FBO 超时即报 error 级，后续每 5min 全部正常，纯属误报）
      if (result.errors.length > 0) {
        syncFailStreak++;
      } else {
        syncFailStreak = 0;
      }
      if (syncFailStreak >= 3) {
        const { emitEvent } = await import("../services/notification-events.js");
        await emitEvent("ORDER_SYNC_FAILED", {
          error: result.errors.slice(0, 3).join("; "),
          storeCount: String(result.storesScanned),
          streak: String(syncFailStreak),
        });
        syncFailStreak = 0; // 告警后清零，避免同故障重复轰炸
      }
    } finally {
      await releaseLock("global", lockToken);
    }
  });

  // Auto-publish queue consumer — drains queued "listing" tasks through the
  // shared listing pipeline (replaces n8n auto-publish workflow).
  // Long timeout: a full batch can take several minutes (scrape + AI + Ozon).
  if (config.autoPublish.enabled) {
    registerJob("auto-publish-queue", config.autoPublish.intervalMin * 60_000, async () => {
      const { processListingBatch } = await import("./auto-publish.js");
      await processListingBatch({
        taskQueue, listingInfra, batchSize: config.autoPublish.batchSize, logger,
      });
    }, { timeoutMs: 15 * 60_000 });
    logger.info({ intervalMin: config.autoPublish.intervalMin, batchSize: config.autoPublish.batchSize }, "Auto-publish queue consumer ENABLED");
  } else {
    logger.info("Auto-publish queue consumer DISABLED via AUTO_PUBLISH_ENABLED=false");
  }

  // Dead letter auto-retry — resets transient dead letters to "retrying"
  // (replaces n8n auto-retry-notify workflow)
  if (config.deadletterAutoRetry.enabled) {
    registerJob("deadletter-auto-retry", config.deadletterAutoRetry.intervalMin * 60_000, async () => {
      const { autoRetryDeadLetters } = await import("./deadletter-retry.js");
      await autoRetryDeadLetters({ logger, limit: 50 });
    });
    logger.info({ intervalMin: config.deadletterAutoRetry.intervalMin }, "Dead letter auto-retry ENABLED");
  } else {
    logger.info("Dead letter auto-retry DISABLED via DEADLETTER_AUTO_RETRY_ENABLED=false");
  }
}

export interface RuntimeJobDeps extends CoreJobDeps {}

/**
 * Register runtime-gated jobs (LOGISTICS_ENABLE, TRANSITION_LOGISTICS, MANUAL_PAY_MODE).
 * Called inside server.listen callback after all services are ready.
 */
export function registerConditionalJobs(deps: RuntimeJobDeps): void {
  const { db, ozonClient, logger } = deps;

  if (process.env.LOGISTICS_ENABLE === "true") {
    registerJob("logistics-delay-check", 30 * 60_000, async () => {
      const { LogisticsOrchestrator } = await import("../services/logistics-orchestrator.js");
      const orchestrator = new LogisticsOrchestrator(db as never);
      const alertCount = await orchestrator.checkDelays();
      if (alertCount > 0) {
        logger.warn({ alertCount }, "Scheduled logistics delay check — alerts sent");
      }
    });
    logger.info("Logistics module ENABLED — auto-shipment + tracking webhooks active");
  }

  if (process.env.TRANSITION_LOGISTICS === "kuajingbus") {
    registerJob("transition-24h-check", 60 * 60_000, async () => {
      const { TransitionLogisticsService } = await import("../services/transition-logistics.js");
      const service = new TransitionLogisticsService(db as never);
      await service.check24hOverdue();
    });
    registerJob("transition-48h-check", 120 * 60_000, async () => {
      const { TransitionLogisticsService } = await import("../services/transition-logistics.js");
      const service = new TransitionLogisticsService(db as never);
      await service.check48hOverdue();
    });
    logger.info("Transition logistics ENABLED — 跨境巴士 semi-auto workflow + TG alerts active");
  }

  registerJob("redis-health-check", 5 * 60_000, async () => {
    const { checkRedisHealth } = await import("../services/redis-health.js");
    await checkRedisHealth();
  });

  registerJob("category-tree-refresh", 24 * 3600_000, async () => {
    const { refreshCategoryTree } = await import("../services/category-resolver.js");
    try {
      const count = await refreshCategoryTree();
      logger.info({ count }, "Daily category tree refresh complete");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Category tree refresh failed — will retry tomorrow");
    }
  });

  if (process.env.MANUAL_PAY_MODE === "true") {
    registerJob("procurement-sync", 10 * 60_000, async () => {
      const { ManualProcurementService } = await import("../services/manual-procurement.js");
      const service = new ManualProcurementService(db as never);
      const result = await service.runProcurementBatch(ozonClient as never);
      if (result.created > 0 || result.failed > 0) {
        logger.info({ created: result.created, failed: result.failed, profitBlocked: result.profitBlocked }, "Procurement batch complete");
      }
    }, { timeoutMs: 5 * 60_000 });
    registerJob("procurement-unpaid-reminder", 60 * 60_000, async () => {
      const { ManualProcurementService } = await import("../services/manual-procurement.js");
      const service = new ManualProcurementService(db as never);
      const count = await service.remindUnpaidOrders();
      if (count > 0) logger.warn({ count }, "Unpaid purchase reminders sent");
    });
    registerJob("procurement-status-poll", 30 * 60_000, async () => {
      const { ManualProcurementService } = await import("../services/manual-procurement.js");
      const service = new ManualProcurementService(db as never);
      await service.pollPurchaseStatus();
    });
    logger.info("Manual procurement ENABLED — 1688 purchase orders created without auto-pay");
  }
}
