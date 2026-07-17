// ============================================================
// Redis Health Monitor — periodic ping + auto-alert on disconnect
// ============================================================

import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";

let consecutiveFailures = 0;
let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 min between repeated alerts

/**
 * Ping Redis and send TG alert if unavailable.
 * Returns true if Redis is healthy.
 */
export async function checkRedisHealth(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;

  // Redis not configured — skip
  if (!redisUrl || redisUrl.includes("CHANGE_ME")) {
    return true;
  }

  try {
    const { cache } = await import("@onzo/cache");
    const hc = await cache.healthCheck();

    if (hc.available) {
      if (consecutiveFailures > 0) {
        logger.info({ consecutiveFailures }, "Redis recovered — connection restored");
        if (Date.now() - lastAlertTime > ALERT_COOLDOWN_MS) {
          await notifier.notify({
            level: "info",
            event: "REDIS_RECOVERED",
            message: `Redis连接已恢复 ✅ (之前连续失败 ${consecutiveFailures} 次)`,
            correlationId: `redis-recovered-${Date.now()}`,
          });
        }
      }
      consecutiveFailures = 0;
      return true;
    }

    consecutiveFailures++;
    logger.warn({ consecutiveFailures, latencyMs: hc.latencyMs }, "Redis health check failed");

    if (consecutiveFailures >= 2 && Date.now() - lastAlertTime > ALERT_COOLDOWN_MS) {
      lastAlertTime = Date.now();
      await notifier.notify({
        level: "critical",
        event: "REDIS_DISCONNECTED",
        message: `🚨 Redis连接断开! 连续失败 ${consecutiveFailures} 次\n影响: 分布式锁、批量任务防重复、缓存全部降级为内存模式\n请检查 Redis 容器状态和网络连通性`,
        correlationId: `redis-down-${Date.now()}`,
        force: true,
        metadata: { consecutiveFailures: String(consecutiveFailures) },
      });
    }

    return false;
  } catch (err) {
    consecutiveFailures++;
    logger.error({ err: (err as Error).message }, "Redis health check exception");
    return false;
  }
}

/** Reset failure counter (for testing) */
export function resetRedisFailures(): void {
  consecutiveFailures = 0;
}
