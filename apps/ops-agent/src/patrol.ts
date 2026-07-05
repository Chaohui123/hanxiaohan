import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { apiClient } from "./api-client.js";
import { aiDiagnose } from "./ai-diagnose.js";
import { logger } from "@onzo/logger";

interface PatrolConfig extends ApiConfig {
  chatId: string;
}

const PATROL_INTERVAL_MS = 60_000;
const ALERT_COOLDOWN_MS = 5 * 60_000;

export let lastStatus = "ok";
export let lastAlertAt = -ALERT_COOLDOWN_MS - 1; // allow first alert
let patrolTimer: ReturnType<typeof setInterval> | null = null;

export function resetPatrolState(): void {
  lastStatus = "ok";
  lastAlertAt = -ALERT_COOLDOWN_MS - 1; // allow first alert immediately
}

/**
 * Execute a single patrol check cycle (exported for testing).
 * Returns: { alerted: boolean, diagnosed: boolean, recovered: boolean }
 */
export async function runPatrolCheck(
  bot: FeishuBot,
  config: PatrolConfig,
  nowOverride?: number,
): Promise<{ alerted: boolean; diagnosed: boolean; recovered: boolean }> {
  const result = { alerted: false, diagnosed: false, recovered: false };

  try {
    const data = await apiClient.ready(config);
    const currentStatus = String(data.status || "unknown");

    if (currentStatus !== "ok" && currentStatus !== lastStatus) {
      const now = nowOverride ?? Date.now();
      if (now - lastAlertAt < ALERT_COOLDOWN_MS) return result;
      lastAlertAt = now;
      result.alerted = true;

      logger.warn({ status: currentStatus }, "Patrol detected status change");

      const checks =
        (data.checks as Record<string, { status: string; latencyMs?: number }>) || {};
      const failedChecks = Object.entries(checks)
        .filter(([, c]) => c.status !== "ok")
        .map(([name, c]) => `❌ ${name}: ${c.status}`)
        .join("\n");

      let alertMsg = `🚨 系统状态变更: ${lastStatus} → ${currentStatus}\n\n${failedChecks}`;

      // RAG 知识库查询：运维异常处理经验
      const failedNames = Object.entries(checks)
        .filter(([, c]) => c.status !== "ok")
        .map(([name]) => name)
        .join(",");
      const isOrderRelated = failedNames.includes("order") || failedNames.includes("aftersales");

      try {
        const ragResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
          body: JSON.stringify({ query: `运维异常 ${failedNames}`, scenario: "ops", topK: 3 }),
          signal: AbortSignal.timeout(5_000),
        });
        if (ragResp.ok) {
          const ragData = await ragResp.json() as { results?: Array<{ content: string }> };
          if (ragData.results?.length) {
            alertMsg += `\n\n🔧 历史处理经验：\n${ragData.results.map((r) => `• ${r.content.slice(0, 150)}`).join("\n")}`;
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "RAG playbook query degraded for patrol");
      }

      // 售后相关异常：额外查询售后话术库
      if (isOrderRelated) {
        try {
          const asResp = await fetch(`${config.apiBase}/api/rag/aftersales/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
            body: JSON.stringify({ query: `售后处理 ${failedNames}`, topK: 3 }),
            signal: AbortSignal.timeout(5_000),
          });
          if (asResp.ok) {
            const asData = await asResp.json() as { results?: Array<{ content_ru?: string; content?: string }> };
            if (asData.results?.length) {
              alertMsg += `\n\n📞 相关售后话术：\n${asData.results.map((r) => `• ${r.content_ru || r.content || ""}`).join("\n")}`;
            }
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "RAG aftersales query degraded for patrol");
        }
      }

      await bot.sendMessage(config.chatId, alertMsg);

      // Run AI diagnosis on failure
      const diagnoseData = await apiClient.diagnose(config).catch(() => null);
      if (diagnoseData) {
        result.diagnosed = true;
        const summary = await aiDiagnose(
          config,
          JSON.stringify(diagnoseData, null, 2),
        );
        await bot.sendMessage(config.chatId, summary);
      }
    }

    if (currentStatus === "ok" && lastStatus !== "ok") {
      await bot.sendMessage(config.chatId, "✅ 系统已恢复正常");
      result.recovered = true;
    }

    lastStatus = currentStatus;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Patrol check failed");
  }

  return result;
}

export function startPatrol(bot: FeishuBot, config: PatrolConfig): void {
  patrolTimer = setInterval(() => {
    runPatrolCheck(bot, config).catch((err) => {
      logger.error({ err }, "Patrol check failed");
    });
  }, PATROL_INTERVAL_MS);

  logger.info({ intervalMs: PATROL_INTERVAL_MS }, "Patrol started");
}

export function stopPatrol(): void {
  if (patrolTimer) {
    clearInterval(patrolTimer);
    patrolTimer = null;
  }
}
