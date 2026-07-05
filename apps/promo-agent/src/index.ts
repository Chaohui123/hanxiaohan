import "dotenv/config";
import { FeishuBot } from "@onzo/feishu-bot";
import type { FeishuConfig } from "@onzo/feishu-bot";
import { logger } from "@onzo/logger";
import type { ApiConfig } from "./api-client.js";
import { registerCommands, syncWatchList } from "./commands.js";
import { startCompetitorWatch, stopCompetitorWatch } from "./competitor-watch.js";
import { startSmartPricing, stopSmartPricing } from "./smart-pricing.js";
import { startPerformanceReports, stopPerformanceReports } from "./performance.js";
import { startDecisionEngine, stopDecisionEngine, isAutoDecisionEnabled, getCurrentPlan } from "./decision-engine.js";
import { register } from "./metrics.js";
import { createServer } from "node:http";

// ---- 环境变量校验 ----
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const CHAT_ID = process.env.PROMO_AGENT_CHAT_ID || process.env.OPS_AGENT_CHAT_ID || "";
const API_BASE =
  process.env.API_BASE_URL || process.env.API_BASE || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  logger.fatal("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  process.exit(1);
}

if (!API_KEY) {
  logger.fatal("API_KEY is required");
  process.exit(1);
}

// ---- 初始化 ----
const apiConfig: ApiConfig = { apiBase: API_BASE, apiKey: API_KEY };

const PROMO_FEISHU_PORT = parseInt(process.env.PROMO_FEISHU_PORT || "8182", 10);

const feishuConfig: FeishuConfig = {
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  chatId: CHAT_ID || undefined,
  port: PROMO_FEISHU_PORT,
};

const bot = new FeishuBot(feishuConfig);

// ---- 同步监控列表 + 注册命令 ----
await syncWatchList(apiConfig);
registerCommands(bot, apiConfig);

// ---- 启动定时任务 ----
if (CHAT_ID) {
  startCompetitorWatch(bot, { chatId: CHAT_ID, apiConfig });
  startSmartPricing(bot, CHAT_ID, apiConfig);
  startPerformanceReports(bot, CHAT_ID, apiConfig);
  startDecisionEngine(bot, CHAT_ID, apiConfig);
} else {
  logger.warn("PROMO_AGENT_CHAT_ID (or OPS_AGENT_CHAT_ID) not set — scheduled tasks disabled");
}

// ---- Health + Metrics + Forward HTTP endpoint ----
const HEALTH_PORT = parseInt(process.env.PROMO_HEALTH_PORT || "9101", 10);
const healthServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    const plan = getCurrentPlan();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      autoDecision: isAutoDecisionEnabled(),
      lastPlanId: plan?.id || null,
      lastPlanStatus: plan?.status || null,
      uptime: process.uptime(),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    }));
  } else if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": register.contentType });
    res.end(await register.metrics());
  } else if (req.url === "/forward" && req.method === "POST") {
    // Inter-agent message forwarding from ops-agent
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const msg = JSON.parse(body) as { chatId: string; text: string; messageId: string; senderOpenId: string };
        await bot.triggerMessage({
          chatId: msg.chatId, chatType: "group",
          messageId: msg.messageId, text: msg.text, senderOpenId: msg.senderOpenId,
        });
        res.writeHead(200).end();
      } catch (err) {
        logger.error({ err }, "Forward handler failed");
        res.writeHead(500).end();
      }
    });
  } else {
    res.writeHead(404).end();
  }
}).listen(HEALTH_PORT, () => {
  logger.info({ port: HEALTH_PORT }, "Health/metrics server ready");
});

// ---- 启动 ----
bot.start().then(() => {
  logger.info({ apiBase: API_BASE, chatId: CHAT_ID || "(none)" }, "promo-agent started");
}).catch((err) => {
  logger.fatal({ err }, "Failed to start promo-agent");
  process.exit(1);
});

// ---- Graceful shutdown ----
function shutdown(signal: string) {
  logger.info({ signal }, "promo-agent shutting down");
  stopCompetitorWatch();
  stopSmartPricing();
  stopPerformanceReports();
  stopDecisionEngine();
  bot.stop();
  healthServer.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
