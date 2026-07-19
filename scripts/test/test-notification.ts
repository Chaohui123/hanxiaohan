#!/usr/bin/env npx tsx
// ============================================================
// Notification Test Script — validates all configured channels
// Usage: npx tsx scripts/test-notification.ts
// ============================================================

import "dotenv/config";
import { notifier } from "../apps/api-services/src/services/notifier.js";
import { emitEvent, NOTIFICATION_EVENTS, EVENT_KEYS } from "../apps/api-services/src/services/notification-events.js";

async function main() {
  console.log("ONZO Notification Test");
  console.log("=".repeat(50));

  // 1. Show configuration
  console.log("\nConfiguration:");
  console.log(`  WeChat: ${process.env.NOTIFY_WECHAT_WEBHOOK ? "CONFIGURED" : "NOT CONFIGURED"}`);
  console.log(`  Telegram: ${process.env.NOTIFY_TELEGRAM_BOT_TOKEN && process.env.NOTIFY_TELEGRAM_CHAT_ID ? "CONFIGURED" : "NOT CONFIGURED"}`);
  console.log(`  Quiet Hours: ${process.env.NOTIFY_QUIET_START || "22"}:00 - ${process.env.NOTIFY_QUIET_END || "7"}:00 UTC`);
  console.log(`  Rate Limit: ${process.env.NOTIFY_RATE_LIMIT || "10"} per 5min`);

  // 2. Show registered events
  console.log(`\nRegistered Events (${NOTIFICATION_EVENTS.length}):`);
  for (const evt of NOTIFICATION_EVENTS) {
    const emoji = evt.level === "critical" ? "🔴" : evt.level === "error" ? "🟠" : evt.level === "warn" ? "🟡" : "🟢";
    console.log(`  ${emoji} ${evt.key.padEnd(25)} ${evt.label}${evt.force ? " [FORCE]" : ""}`);
  }

  // 3. Channel health check
  console.log("\nChannel Health:");
  const health = notifier.getHealth();
  for (const h of health) {
    console.log(`  ${h.channel}: ${h.available ? "✅ Available" : "❌ Unavailable"} (${h.successCount} OK, ${h.failCount} fail)`);
    if (h.lastError) console.log(`    Last error: ${h.lastError}`);
  }

  if (!notifier.enabled) {
    console.log("\n⚠️  No notification channels configured.");
    console.log("   Set NOTIFY_WECHAT_WEBHOOK or NOTIFY_TELEGRAM_BOT_TOKEN + NOTIFY_TELEGRAM_CHAT_ID in .env");
    process.exit(0);
  }

  // 4. Send test notification
  console.log("\nSending test notification...");
  await notifier.notify({
    level: "info",
    event: "TEST_NOTIFICATION",
    message: "ONZO通知系统测试 — 如果你收到这条消息，说明通知配置正确 ✅",
    correlationId: `test-${Date.now()}`,
  });
  console.log("  Sent. Check your WeChat/Telegram.");

  // 5. Test rate limiting
  console.log("\nTesting rate limit (sending 15 rapid notifications)...");
  for (let i = 0; i < 15; i++) {
    await emitEvent(EVENT_KEYS.LISTING_SUCCESS, {
      title: `Test Product #${i}`,
      draftId: `draft-${i}`,
    }, `ratelimit-test-${i}`).catch(() => {});
  }
  console.log("  Done. Only first 10 should have been sent (rate limit).");

  // 6. Test event emission
  console.log("\nTesting event emission...");
  await emitEvent(EVENT_KEYS.ORDER_NEW, {
    postingNumber: "TEST-001",
    productCount: "3",
    priceRub: "1500",
  }).catch(() => {});
  console.log("  Sent ORDER_NEW event.");

  console.log("\n✅ Notification test complete.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
