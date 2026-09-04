// ============================================================
// Dashboard Auth Routes — 独立密码登录（HMAC 自包含 token）
// POST /api/auth/login — 密码 → token（7 天有效）
//
// 设计：dashboard 用户不再接触主 API_KEY。密码配置在 DASHBOARD_PASSWORD。
// token 为无状态 HMAC 签名：v1.<expiryMs>.<nonce>.<hmacHex>，
// 由 middleware/auth.ts 校验（与 API key 双轨并行）。
// ============================================================

import crypto from "node:crypto";
import { Router } from "express";
import { logger } from "@onzo/logger";

const TOKEN_TTL_MS = 7 * 24 * 3600_000; // 7 天
const TOKEN_PREFIX = "v1";

function getDashboardSecret(): string {
  return process.env.DASHBOARD_SECRET || process.env.API_KEY || "";
}

/** 签发 dashboard token（无状态，HMAC-SHA256 自包含） */
export function signDashboardToken(): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${TOKEN_PREFIX}.${expiry}.${nonce}`;
  const hmac = crypto.createHmac("sha256", getDashboardSecret()).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/** 校验 dashboard token；非法格式/签名不符/过期均返回 false */
export function verifyDashboardToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return false;
  const [, expiryStr, nonce, hmac] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (!expiry || !nonce || !hmac || Date.now() > expiry) return false;
  const expected = crypto.createHmac("sha256", getDashboardSecret())
    .update(`${TOKEN_PREFIX}.${expiryStr}.${nonce}`).digest("hex");
  const a = Buffer.from(hmac, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 登录暴破防护：同一 IP 连续失败 5 次锁 10 分钟（内存态，单实例足够）----
const failMap = new Map<string, { count: number; lockedUntil: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60_000;

function isLocked(ip: string): boolean {
  const rec = failMap.get(ip);
  return !!rec && rec.lockedUntil > Date.now();
}

function recordFail(ip: string): void {
  const rec = failMap.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  failMap.set(ip, rec);
  // 防无界增长
  if (failMap.size > 1000) failMap.clear();
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen, 0);
  const paddedB = Buffer.alloc(maxLen, 0);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

export function createAuthRouter(): Router {
  const router = Router();

  router.post("/auth/login", (req, res) => {
    const password = String((req.body as { password?: string })?.password || "");
    const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
    const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();

    if (!dashboardPassword) {
      res.status(503).json({
        success: false,
        error: { code: "NOT_CONFIGURED", message: "未配置 DASHBOARD_PASSWORD，请联系管理员在服务器 .env.production 中设置", retryable: false },
      });
      return;
    }

    if (isLocked(clientIp)) {
      res.status(429).json({
        success: false,
        error: { code: "LOCKED", message: "失败次数过多，请 10 分钟后再试", retryable: true },
      });
      return;
    }

    if (!password || !constantTimeEqual(password, dashboardPassword)) {
      recordFail(clientIp);
      logger.warn({ clientIp }, "Dashboard login failed");
      res.status(401).json({
        success: false,
        error: { code: "WRONG_PASSWORD", message: "密码错误", retryable: false },
      });
      return;
    }

    failMap.delete(clientIp);
    const token = signDashboardToken();
    logger.info({ clientIp }, "Dashboard login success");
    res.json({ success: true, data: { token, expiresInDays: 7 } });
  });

  return router;
}
