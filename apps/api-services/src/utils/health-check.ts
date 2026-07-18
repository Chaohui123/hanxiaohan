// ============================================================
// Health Check Utilities — DeepSeek, Chromium, Agent status
// ============================================================
import { logger } from "@onzo/logger";

export interface HealthResult {
  code: number;
  status: string;
  llmModel: string;
  opsAgentRunning: boolean;
  promoAgentRunning: boolean;
  crawlAvailable: boolean;
  dbConnected: boolean;
  timestamp: string;
  details?: Record<string, string>;
}

let _lastOpsOk = false;
let _lastPromoOk = false;
let _lastDeepSeekOk = false;
let _lastChromiumOk = false;

export function setAgentStatus(agent: "ops" | "promo", ok: boolean) {
  if (agent === "ops") _lastOpsOk = ok;
  else _lastPromoOk = ok;
}

/** Check DeepSeek API connectivity */
async function checkDeepSeek(): Promise<boolean> {
  try {
    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ""}`,
      },
      body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch { return false; }
}

/** Check Chromium browser availability */
async function checkChromium(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("chromium-browser --version", { timeout: 5_000 });
    return true;
  } catch { return false; }
}

/** Check if ops-agent is running (HTTP call to its review server) */
async function checkOpsAgent(): Promise<boolean> {
  try {
    const resp = await fetch("http://ops-agent:8183/health", { signal: AbortSignal.timeout(3_000) });
    if (resp.ok) { _lastOpsOk = true; return true; }
    return _lastOpsOk; // sticky: once seen as up, stays "last known ok" for 30s
  } catch { return _lastOpsOk; }
}

/** Check if promo-agent is running */
async function checkPromoAgent(): Promise<boolean> {
  try {
    const resp = await fetch("http://promo-agent:9101/health", { signal: AbortSignal.timeout(3_000) });
    if (resp.ok) { _lastPromoOk = true; return true; }
    return _lastPromoOk;
  } catch { return _lastPromoOk; }
}

/** Check DB connectivity */
async function checkDb(): Promise<boolean> {
  try {
    const { getDb } = await import("../db/connection.js");
    const db = await getDb();
    if (!db) return false;
    await db.all("SELECT 1");
    return true;
  } catch { return false; }
}

/** Full health check */
export async function getFullHealth(): Promise<HealthResult> {
  const [deepseekOk, chromiumOk, opsOk, promoOk, dbOk] = await Promise.allSettled([
    checkDeepSeek(), checkChromium(), checkOpsAgent(), checkPromoAgent(), checkDb(),
  ]);

  const ds = deepseekOk.status === "fulfilled" ? deepseekOk.value : false;
  const ch = chromiumOk.status === "fulfilled" ? chromiumOk.value : false;
  const op = opsOk.status === "fulfilled" ? opsOk.value : _lastOpsOk;
  const pr = promoOk.status === "fulfilled" ? promoOk.value : _lastPromoOk;
  const db = dbOk.status === "fulfilled" ? dbOk.value : false;

  _lastDeepSeekOk = ds;
  _lastChromiumOk = ch;

  const allHealthy = ds && ch && db;

  return {
    code: 0,
    status: allHealthy ? "ok" : "degraded",
    llmModel: process.env.LLM_MODEL_ID || "deepseek-v4-pro",
    opsAgentRunning: op,
    promoAgentRunning: pr,
    crawlAvailable: ch,
    dbConnected: db,
    timestamp: new Date().toISOString(),
    details: {
      deepseek: ds ? "connected" : "disconnected",
      chromium: ch ? "available" : "unavailable",
      opsAgent: op ? "running" : "stopped",
      promoAgent: pr ? "running" : "stopped",
      database: db ? "connected" : "disconnected",
    },
  };
}
