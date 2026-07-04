import type { FeishuBot } from "./feishu.js";
import type { ApiConfig } from "./api-client.js";
import { apiClient } from "./api-client.js";
import { aiDiagnose } from "./ai-diagnose.js";
import { logger } from "@onzo/logger";

interface PatrolConfig extends ApiConfig {
  chatId: string;
}

const PATROL_INTERVAL_MS = 60_000;
const ALERT_COOLDOWN_MS = 5 * 60_000;

let lastStatus = "ok";
let lastAlertAt = 0;
let patrolTimer: ReturnType<typeof setInterval> | null = null;

export function startPatrol(bot: FeishuBot, config: PatrolConfig): void {
  patrolTimer = setInterval(async () => {
    try {
      const data = await apiClient.ready(config);
      const currentStatus = String(data.status || "unknown");

      if (currentStatus !== "ok" && currentStatus !== lastStatus) {
        const now = Date.now();
        if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
        lastAlertAt = now;

        logger.warn({ status: currentStatus }, "Patrol detected status change");

        const checks =
          (data.checks as Record<string, { status: string; latencyMs?: number }>) || {};
        const failedChecks = Object.entries(checks)
          .filter(([, c]) => c.status !== "ok")
          .map(([name, c]) => `❌ ${name}: ${c.status}`)
          .join("\n");

        await bot.sendMessage(
          config.chatId,
          `🚨 系统状态变更: ${lastStatus} → ${currentStatus}\n\n${failedChecks}`,
        );

        // Run AI diagnosis on failure
        const diagnoseData = await apiClient.diagnose(config).catch(() => null);
        if (diagnoseData) {
          const summary = await aiDiagnose(
            config,
            JSON.stringify(diagnoseData, null, 2),
          );
          await bot.sendMessage(config.chatId, summary);
        }
      }

      if (currentStatus === "ok" && lastStatus !== "ok") {
        await bot.sendMessage(config.chatId, "✅ 系统已恢复正常");
      }

      lastStatus = currentStatus;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Patrol check failed");
    }
  }, PATROL_INTERVAL_MS);

  logger.info({ intervalMs: PATROL_INTERVAL_MS }, "Patrol started");
}

export function stopPatrol(): void {
  if (patrolTimer) {
    clearInterval(patrolTimer);
    patrolTimer = null;
  }
}
