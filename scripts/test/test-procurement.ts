// One-shot procurement flow test — inserts order, runs full cycle, shows results
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { getDb } from "../apps/api-services/src/db/connection.js";
import { ManualProcurementService } from "../apps/api-services/src/services/manual-procurement.js";

async function main() {
  console.log("MANUAL_PAY_MODE:", process.env.MANUAL_PAY_MODE);
  console.log("FREIGHT_ADDRESS:", (process.env.FREIGHT_ADDRESS || "").substring(0, 35) + "...");

  const db = await getDb();
  if (!db) { console.error("DB unavailable"); process.exit(1); }

  const svc = new ManualProcurementService(db);
  console.log("Service enabled:", svc.enabled);

  const mockOzon = { request: async () => ({}), ping: async () => true };

  // === Step 1: Sync & Match ===
  console.log("\n=== Step 1: Sync & Match ===");
  const { matched } = await svc.syncAndMatch(mockOzon);
  console.log("Orders found:", matched.length);

  for (const { order, skuMatches } of matched) {
    console.log("\n📦 Order:", order.postingNumber);
    console.log("   Products:", order.products.map((p) => `${p.name} ×${p.quantity}`).join(", "));
    console.log("   Total:", order.totalPriceRub, "RUB");
    for (const m of skuMatches) {
      console.log(`   SKU ${m.sku} → 1688: ¥${m.purchasePriceCny}/件 | ${m.weightKg}kg | ${m.matched ? "✓ matched" : "✗ no match"}`);
    }

    // === Step 2: Profit Check ===
    console.log("\n=== Step 2: Profit Check ===");
    const profit = await svc.checkProfit(order, skuMatches);
    console.log("   Passed:", profit.passed);
    console.log("   Revenue:", profit.priceRub, "RUB");
    console.log("   Purchase cost:", Math.round(profit.purchaseCostCny * 100) / 100, "CNY ≈", Math.round(profit.purchaseCostCny * 11.5), "RUB");
    console.log("   Est. logistics:", profit.estimatedLogisticsRub, "RUB");
    console.log("   Est. profit:", profit.estimatedProfitRub, "RUB");
    console.log("   Margin:", (profit.marginPercent * 100).toFixed(1) + "%", "(threshold:", (profit.threshold * 100).toFixed(0) + "%)");
    if (profit.reason) console.log("   ⚠️ ", profit.reason);

    if (!profit.passed) {
      console.log("\n   ❌ BLOCKED — 利润率不达标，不创建采购单");
      continue;
    }

    // === Step 3: Create Purchase Order ===
    console.log("\n=== Step 3: Create Purchase Order (1688) ===");
    const result = await svc.createPurchaseOrder(order, skuMatches);
    console.log("   Success:", result.success);
    console.log("   Purchase ID:", result.purchaseId);
    console.log("   Total:", "¥" + result.totalAmountCny, "CNY");
    console.log("   Payment status:", result.paymentStatus);
    console.log("   Needs manual payment:", result.needsManualPayment);
    if (result.error) console.log("   Error:", result.error);

    if (result.success) {
      // === Step 4: TG Notification ===
      console.log("\n=== Step 4: TG Payment Notification ===");
      console.log("   ┌─────────────────────────────────────┐");
      console.log("   │ 🛒 待支付采购单 — 请登录1688付款     │");
      console.log("   │                                     │");
      console.log(`   │ Ozon订单: ${order.postingNumber.padEnd(25)}│`);
      console.log(`   │ 采购单号: ${(result.purchaseId || "").padEnd(25)}│`);
      console.log(`   │ 应付金额: ¥${String(result.totalAmountCny).padEnd(23)}│`);
      console.log("   │                                     │");
      console.log("   │ 操作指引:                            │");
      console.log("   │ 1️⃣ 登录: https://login.1688.com      │");
      console.log("   │ 2️⃣ 进入「分销代发」→「待付款订单」     │");
      console.log(`   │ 3️⃣ 找到采购单完成批量付款              │`);
      console.log("   │                                     │");
      console.log("   │ ⏰ 请在24小时内完成支付               │");
      console.log("   └─────────────────────────────────────┘");

      await svc.sendPaymentReminder(result, order, skuMatches);
      console.log("\n   ✅ TG通知已发送 (如配置了TG)");
    }
  }

  // === Final: Show DB state ===
  console.log("\n=== purchase_1688 Table ===");
  const purchases = await db.all(
    "SELECT id, ozon_posting_number, total_amount_cny, payment_status, freight_address FROM purchase_1688 ORDER BY created_at DESC LIMIT 3"
  ) as Array<Record<string, unknown>>;
  for (const p of purchases) {
    console.log("  ", p.id, "|", p.ozon_posting_number, "| ¥" + p.total_amount_cny, "|", p.payment_status);
    console.log("    货代地址:", String(p.freight_address || "").substring(0, 40) + "...");
  }

  console.log("\n🏁 Flow complete. Status: pending_payment = 等待人工去1688付款");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});
