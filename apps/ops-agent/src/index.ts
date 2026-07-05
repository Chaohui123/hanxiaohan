import "dotenv/config";
import { FeishuBot } from "@onzo/feishu-bot";
import type { FeishuConfig } from "@onzo/feishu-bot";
import { registerCommands } from "./commands.js";
import { startPatrol, stopPatrol } from "./patrol.js";
import { logger } from "@onzo/logger";
import type { ApiConfig } from "./api-client.js";

// ---- 环境变量校验 ----
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const API_BASE =
  process.env.API_BASE_URL || process.env.API_BASE || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";
const CHAT_ID = process.env.OPS_AGENT_CHAT_ID || "";

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  logger.fatal("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  process.exit(1);
}

// ---- 初始化 ----
const apiConfig: ApiConfig = { apiBase: API_BASE, apiKey: API_KEY };

const feishuConfig: FeishuConfig = {
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  chatId: CHAT_ID || undefined,
};

const bot = new FeishuBot(feishuConfig);

registerCommands(bot, apiConfig);

if (CHAT_ID) {
  startPatrol(bot, { ...apiConfig, chatId: CHAT_ID });
} else {
  logger.warn("OPS_AGENT_CHAT_ID not set — patrol disabled");
}

// ---- 启动 ----
bot.start().then(() => {
  logger.info(
    { apiBase: API_BASE, chatId: CHAT_ID || "(none)" },
    "Feishu Bot started",
  );
}).catch((err) => {
  logger.fatal({ err }, "Failed to start Feishu Bot");
  process.exit(1);
});

// ---- Graceful shutdown ----
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  stopPatrol();
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
