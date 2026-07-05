import type { ApiConfig } from "./api-client.js";
import { opsApi, statsApi } from "./api-client.js";
import { logger } from "@onzo/logger";

// ============================================================
// 类型
// ============================================================

export interface CrossValidationResult {
  systemHealthy: boolean;
  apiLatencyOk: boolean;
  noActiveIncidents: boolean;
  budgetRemaining: boolean;
  dailyLimitNotReached: boolean;
  passed: boolean;
  issues: string[];
  validatedAt: string;
}

// ============================================================
// 配置
// ============================================================

const MAX_DAILY_AUTO_ACTIONS = parseInt(process.env.PROMO_MAX_DAILY_ACTIONS || "10", 10);
const MAX_API_LATENCY_MS = 3000;
const MAX_DAILY_SPEND = parseFloat(process.env.PROMO_MAX_DAILY_SPEND || "500");

// ============================================================
// 交叉验证
// ============================================================

/**
 * 执行 5 项交叉验证，全部通过才允许自动执行
 */
export async function crossValidate(
  config: ApiConfig,
  dailyActionCount: number,
): Promise<CrossValidationResult> {
  const results = await Promise.all([
    checkSystemHealth(config),
    checkApiLatency(config),
    checkActiveIncidents(config),
    checkBudgetRemaining(config),
    checkDailyLimit(dailyActionCount),
  ]);

  const [systemHealthy, apiLatencyOk, noActiveIncidents, budgetRemaining, dailyLimitNotReached] =
    results;

  const issues: string[] = [];
  for (const r of results) {
    if (r.issue) issues.push(r.issue);
  }

  const passed =
    systemHealthy.value &&
    apiLatencyOk.value &&
    noActiveIncidents.value &&
    budgetRemaining.value &&
    dailyLimitNotReached.value;

  logger.info(
    {
      systemHealthy: systemHealthy.value,
      apiLatencyOk: apiLatencyOk.value,
      noActiveIncidents: noActiveIncidents.value,
      budgetRemaining: budgetRemaining.value,
      dailyLimitNotReached: dailyLimitNotReached.value,
      passed,
    },
    "Cross-validation complete",
  );

  // RAG 写回：验证失败时记录到 Playbook
  if (!passed) {
    fetch(`${config.apiBase}/api/rag/playbook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({
        title: `交叉验证失败: ${issues.join(", ")}`,
        scenario: "ops",
        content: `验证项:\n- 系统健康: ${systemHealthy.value}\n- API延迟: ${apiLatencyOk.value}\n- 活跃事件: ${noActiveIncidents.value}\n- 预算: ${budgetRemaining.value}\n- 限额: ${dailyLimitNotReached.value}\n\n问题:\n${issues.join("\n")}`,
        tags: ["验证", "失败"],
        author: "cross-validator",
        priority: 1,
      }),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  }

  return {
    systemHealthy: systemHealthy.value,
    apiLatencyOk: apiLatencyOk.value,
    noActiveIncidents: noActiveIncidents.value,
    budgetRemaining: budgetRemaining.value,
    dailyLimitNotReached: dailyLimitNotReached.value,
    passed,
    issues,
    validatedAt: new Date().toISOString(),
  };
}

// ============================================================
// 单项检查
// ============================================================

interface CheckResult {
  value: boolean;
  issue: string;
}

/** 1. 系统健康检查 */
async function checkSystemHealth(config: ApiConfig): Promise<CheckResult> {
  try {
    const health = await opsApi.health(config);
    const status = String((health as Record<string, unknown>).status || "");
    if (status !== "ok") {
      logger.warn({ status }, "System health check failed");
      return {
        value: false,
        issue: `系统状态异常: ${status || "unknown"}`,
      };
    }
    return { value: true, issue: "" };
  } catch (err) {
    logger.error({ err }, "System health check error");
    return {
      value: false,
      issue: `API 服务不可达: ${(err as Error).message}`,
    };
  }
}

/** 2. API 延迟检查 */
async function checkApiLatency(config: ApiConfig): Promise<CheckResult> {
  try {
    const start = Date.now();
    await opsApi.ready(config);
    const latency = Date.now() - start;

    if (latency > MAX_API_LATENCY_MS) {
      logger.warn({ latency }, "API latency too high");
      return {
        value: false,
        issue: `API 延迟过高 (${latency}ms)`,
      };
    }
    return { value: true, issue: "" };
  } catch (err) {
    logger.error({ err }, "API readiness check error");
    return {
      value: false,
      issue: `API 就绪检查失败: ${(err as Error).message}`,
    };
  }
}

/** 3. 活跃事件检查 — 调用 opsApi.diagnose 检测事故 */
async function checkActiveIncidents(config: ApiConfig): Promise<CheckResult> {
  try {
    const data = await opsApi.diagnose(config);
    const incidents =
      (data as { activeIncidents?: unknown[]; criticalErrors?: unknown[] }).activeIncidents ||
      (data as { activeIncidents?: unknown[]; criticalErrors?: unknown[] }).criticalErrors;

    if (incidents && Array.isArray(incidents) && incidents.length > 0) {
      logger.warn({ incidentCount: incidents.length }, "Active incidents detected");
      return {
        value: false,
        issue: `检测到活跃事件 (${incidents.length} 项)`,
      };
    }
    return { value: true, issue: "" };
  } catch {
    // 诊断不可用不应阻断推广
    logger.warn("Diagnose API unavailable, assuming no incidents");
    return { value: true, issue: "" };
  }
}

/** 4. 预算检查 */
async function checkBudgetRemaining(config: ApiConfig): Promise<CheckResult> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const costData = await statsApi.promoCost(config, today, today);
    const adSpend = Number(costData.adSpend || 0);

    if (adSpend >= MAX_DAILY_SPEND) {
      logger.warn({ adSpend, maxDaily: MAX_DAILY_SPEND }, "Daily budget exceeded");

      // RAG 知识库增强：预算优化策略
      let issue = `今日广告花费 ${adSpend}₽ 已达上限 (${MAX_DAILY_SPEND}₽)`;
      try {
        const ragResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
          body: JSON.stringify({ query: "预算不足 优化策略", scenario: "budget", topK: 3 }),
          signal: AbortSignal.timeout(5_000),
        });
        if (ragResp.ok) {
          const ragData = await ragResp.json() as { results?: Array<{ content: string }> };
          if (ragData.results?.length) {
            issue += ` | 优化建议: ${ragData.results[0].content.slice(0, 100)}`;
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "RAG playbook query degraded for budget check");
      }

      return { value: false, issue };
    }
    return { value: true, issue: "" };
  } catch (err) {
    // 查询失败不阻断（可能 API 未实现）
    logger.warn({ err }, "Budget check failed, assuming ok");
    return { value: true, issue: "" };
  }
}

/** 5. 每日操作限额 */
function checkDailyLimit(dailyActionCount: number): CheckResult {
  if (dailyActionCount >= MAX_DAILY_AUTO_ACTIONS) {
    return {
      value: false,
      issue: `今日自动操作已达上限 (${MAX_DAILY_AUTO_ACTIONS})`,
    };
  }
  return { value: true, issue: "" };
}
