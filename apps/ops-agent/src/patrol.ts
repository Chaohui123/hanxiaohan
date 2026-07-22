import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { apiClient } from "./api-client.js";
import { aiDiagnose } from "./ai-diagnose.js";
import { logger } from "@onzo/logger";
import { queryRag, writeRag } from "@onzo/embedding";

interface PatrolConfig extends ApiConfig {
  chatId: string;
}

const PATROL_INTERVAL_MS = 60_000;
const ALERT_COOLDOWN_MS = 5 * 60_000;

// /health returns "ok", /ready returns "ready" — both mean healthy.
// (patrol used to compare against only "ok", causing false alerts on /ready)
const OK_STATUSES = new Set(["ok", "ready"]);

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

    if (!OK_STATUSES.has(currentStatus) && currentStatus !== lastStatus) {
      const now = nowOverride ?? Date.now();
      if (now - lastAlertAt < ALERT_COOLDOWN_MS) return result;
      lastAlertAt = now;
      result.alerted = true;

      const checks = (data.checks as Record<string, unknown>) || {};
      const failedEntries = Object.entries(checks).filter(([, c]) => {
        const st = typeof c === "string" ? c : (c as { status?: string }).status || "unknown";
        return st !== "ok";
      });

      // Severity: DB/error → critical, degraded/warn → warn
      const isCritical = currentStatus === "error" || currentStatus === "unhealthy" ||
        failedEntries.some(([name]) => name === "db");
      const severity = isCritical ? "critical" : "warn";
      const prefix = isCritical ? "🔴🔴 严重告警" : "🟡 系统提醒";

      logger.warn({ status: currentStatus, severity }, "Patrol detected status change");

      const failedChecks = failedEntries
        .map(([name, c]) => {
          const st = typeof c === "string" ? c : (c as { status?: string }).status || "unknown";
          return `❌ ${name}: ${st}`;
        })
        .join("\n");

      let alertMsg = `${prefix}\n状态: ${lastStatus} → ${currentStatus}\n\n${failedChecks}`;
      if (isCritical) alertMsg += "\n\n⚡ @所有人 请立即处理";

      // RAG 知识库查询：运维异常处理经验
      const failedNames = failedEntries.map(([name]) => name).join(",");
      const isOrderRelated = failedNames.includes("order") || failedNames.includes("aftersales");

      const playbookResults = await queryRag(config, "playbook", `运维异常 ${failedNames}`, { scenario: "ops" });
      if (playbookResults.length) {
        alertMsg += `\n\n🔧 历史处理经验：\n${playbookResults.map((r: Record<string,unknown>) => `• ${String(r.content).slice(0, 150)}`).join("\n")}`;
      }

      if (isOrderRelated) {
        const asResults = await queryRag(config, "aftersales", `售后处理 ${failedNames}`);
        if (asResults.length) {
          alertMsg += `\n\n📞 相关售后话术：\n${asResults.map((r: Record<string,unknown>) => `• ${r.content_ru || r.content || ""}`).join("\n")}`;
        }
      }

      // Quiet hours: non-critical alerts suppressed during 22:00-07:00 UTC
      const quietRange = (process.env.OPS_AGENT_QUIET_HOURS || "22:00-07:00").split("-");
      const hour = new Date().getUTCHours();
      const inQuiet = hour >= parseInt(quietRange[0]) || hour < parseInt(quietRange[1]);
      if (!inQuiet || isCritical) {
        await bot.sendMessage(config.chatId, alertMsg);
      } else {
        logger.info({ severity, inQuiet: true }, "Patrol alert suppressed by quiet hours");
      }

      writeRag(config, "playbook", {
        title: `巡检异常: ${failedNames}`, scenario: "ops",
        content: `状态变更: ${lastStatus} → ${currentStatus}\n失败组件: ${failedNames}\n${failedChecks}`,
        tags: ["巡检", "异常"], author: "patrol", priority: 1,
      });

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

    if (OK_STATUSES.has(currentStatus) && !OK_STATUSES.has(lastStatus)) {
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
