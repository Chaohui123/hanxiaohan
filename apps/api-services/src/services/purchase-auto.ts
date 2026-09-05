// ============================================================
// Auto Purchase Record — 新订单自动创建 1688 采购待处理记录
//
// 业务规则（2026-09-05 用户要求）：每发生一个订单，采购列表必须出现一条
// 待处理记录并计入成本。两个订单来源（webhook 即时路径 order-processor、
// 轮询兜底路径 ozon-order-sync）都调 ensurePendingPurchase ——
// ON CONFLICT DO NOTHING 保证幂等，先到先得。
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { logger } from "@onzo/logger";

export interface AutoPurchaseProduct {
  offerId?: string;
  sku: number;
  quantity: number;
}

interface SkuMappingRow {
  purchase_price_cny: number;
  source_1688_url: string;
  weight_kg: number;
}

/**
 * 为新订单创建采购待处理记录（已存在则跳过）。
 * 成本 = Σ(1688 映射单价 × 数量)；无映射的商品计 0 并在 risk_check_json 标注。
 */
export async function ensurePendingPurchase(
  db: DbAdapter,
  params: {
    storeId: string;
    postingNumber: string;
    ozonOrderId: number;
    products: AutoPurchaseProduct[];
  },
): Promise<boolean> {
  const { storeId, postingNumber, ozonOrderId, products } = params;
  if (!products.length) return false;

  // 查询 1688 映射（成本/货源链接/重量）
  const skuList: Array<{ sku: number; offerId?: string; quantity: number; unitPriceCny: number }> = [];
  const unmapped: string[] = [];
  let totalCny = 0;
  let source1688Url = "";

  for (const p of products) {
    let priceCny = 0;
    if (p.offerId) {
      const rows = await db.all<SkuMappingRow>(
        "SELECT purchase_price_cny, source_1688_url, weight_kg FROM sku_1688_mapping WHERE ozon_offer_id = ? AND ozon_sku = ? LIMIT 1",
        [p.offerId, p.sku],
      ).catch(() => [] as SkuMappingRow[]);
      // sku 对不上时退回仅按 offerId 匹配（多变体映射不齐的兜底）
      const row = rows[0] ?? (await db.all<SkuMappingRow>(
        "SELECT purchase_price_cny, source_1688_url, weight_kg FROM sku_1688_mapping WHERE ozon_offer_id = ? LIMIT 1",
        [p.offerId],
      ).catch(() => [] as SkuMappingRow[]))[0];
      if (row) {
        priceCny = Number(row.purchase_price_cny) || 0;
        if (!source1688Url && row.source_1688_url && row.source_1688_url !== "manual-input") {
          source1688Url = row.source_1688_url;
        }
      }
    }
    if (priceCny <= 0) unmapped.push(p.offerId || String(p.sku));
    skuList.push({ sku: p.sku, offerId: p.offerId, quantity: p.quantity, unitPriceCny: priceCny });
    totalCny += priceCny * p.quantity;
  }

  const riskCheck = {
    autoCreated: true,
    unmappedSkus: unmapped,
    note: unmapped.length > 0 ? "部分商品缺 1688 映射，成本未计入" : "全部商品已映射",
  };

  const result = await db.run(
    `INSERT INTO purchase_1688
       (id, store_id, ozon_posting_number, ozon_order_id, source_1688_url, offer_id,
        sku_list_json, total_amount_cny, payment_status, pay_channel, risk_check_json,
        logistics_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'auto', ?, 'idle', NOW(), NOW())
     ON CONFLICT(store_id, ozon_posting_number) DO NOTHING`,
    [
      `purchase-${postingNumber}`,
      storeId,
      postingNumber,
      ozonOrderId,
      source1688Url,
      products[0].offerId ?? "",
      JSON.stringify(skuList),
      Math.round(totalCny * 100) / 100,
      JSON.stringify(riskCheck),
    ],
  );

  const created = result.changes > 0;
  if (created) {
    logger.info({ postingNumber, totalCny, unmapped: unmapped.length }, "Auto purchase record created (pending)");
  }
  return created;
}
