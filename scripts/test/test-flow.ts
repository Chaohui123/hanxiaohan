// Quick procurement test — creates order, prints 1688 manual order guide
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { getDb } from "../apps/api-services/src/db/connection.js";
import { ManualProcurementService } from "../apps/api-services/src/services/manual-procurement.js";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const svc = new ManualProcurementService(db);
  const mockO = { request: async () => ({}), ping: async () => true };
  const { matched } = await svc.syncAndMatch(mockO);

  if (matched.length === 0) {
    console.log("No awaiting_deliver orders found. Insert one first.");
    return;
  }

  for (const { order, skuMatches } of matched) {
    const profit = await svc.checkProfit(order, skuMatches);
    if (!profit.passed) {
      console.log("BLOCKED:", profit.reason);
      continue;
    }

    // Supplier quality gate
    const blocked = svc.checkSupplierQuality(skuMatches, order);
    if (blocked) {
      console.log("\n🚫 供应商拦截 — 24h揽收率不达标");
      console.log("   供应商:", skuMatches[0]?.supplierName);
      console.log("   揽收率:", (skuMatches[0]?.supplierPickupRate * 100).toFixed(0) + "%");
      console.log("   要求: ≥", (parseFloat(process.env.SUPPLIER_MIN_PICKUP_RATE || "0.9") * 100).toFixed(0) + "%");
      continue;
    }

    const r = await svc.createPurchaseOrder(order, skuMatches);

    console.log("\n========================================");
    console.log("       1688 手动下单指引");
    console.log("========================================");
    console.log("Ozon订单号:", order.postingNumber);
    console.log("采购单ID:  ", r.purchaseId);
    console.log("商品:      ", order.products[0]?.name);
    console.log("数量:      ", order.products[0]?.quantity, "件");
    console.log("1688单价:  ¥", skuMatches[0]?.purchasePriceCny, "CNY");
    console.log("应付总额:  ¥", r.totalAmountCny, "CNY");
    console.log("状态:      ", r.paymentStatus);
    console.log("----------------------------------------");
    console.log("操作步骤:");
    console.log("1. 打开 https://www.1688.com");
    console.log("2. 搜索:", order.products[0]?.name);
    console.log("3. 找同款 → 加入进货单");
    console.log("4. 结算时收货地址填:");
    console.log("  ", process.env.FREIGHT_ADDRESS);
    console.log("5. 完成付款，记下1688订单号");
    console.log("6. 回填命令:");
    console.log('  curl -X POST http://localhost:3000/api/v1/procurement/confirm \\');
    console.log('    -H "Content-Type: application/json" \\');
    console.log('    -d \'{"postingNumber":"' + order.postingNumber + '","alibabaOrderId":"填入1688订单号","amountCny":' + r.totalAmountCny + "}'");
    console.log("========================================\n");

    if (r.success) await svc.sendPaymentReminder(r, order, skuMatches);
  }

  console.log("Done. TG notification sent.\n");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
