// ============================================================
// Warehouse Band Sync — 价格×重量→CEL 档位仓每日自检
//
// 背景（2026-09-06 实证）：自动迁仓只挂在调价路由上；凡绕过路由的改价
// （import 恢复、后台手动改价）都会造成"价格×仓库"错配，Ozon 报
// 「所选配送方式不适用此价格」。本 job 每日幂等纠正，不依赖调价路由单点。
//
// 档位表（CEL 官方 8/20 用户供图，与 inventory.route.ts 调价路由一致）：
//   XS(CEL陆运 …150)      ≤500g 且 ≤135¥
//   Budget(CEL陆运2 …290)  501g-30kg 且 ≤135¥（DISABLED，落档需后台先启用）
//   Small(CEL陆运3 …520)   ≤2kg 且 135-635¥
//   Big(CEL仓库3 …710)     2-30kg 且 135-635¥
//   PremS(CLE陆运5 …150)   ≤5kg 且 635-22525¥
//   PremB(CEL陆运4 …120)   ≥5kg 且 635-22525¥
// 幂等：目标仓=rfbs 总库存、其余 CEL 仓=0。FBP 仓（Ural/GUOO）不在覆盖范围。
// ============================================================

import { logger } from "@onzo/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OzonClientLike = any;

const WH = {
  XS: 1020005021424150,
  BUDGET: 1020005021424290,
  SMALL: 1020005021424520,
  BIG: 1020005021424710,
  PREM_S: 1020005027799150,
  PREM_B: 1020005027716120,
} as const;

const ALL_CEL = Object.values(WH) as number[];

export interface BandSyncResult {
  checked: number;
  migrated: string[];
  skipped: string[];
  errors: string[];
}

function targetWarehouse(priceCny: number, weightG: number): number {
  if (priceCny <= 135) return weightG <= 500 ? WH.XS : WH.BUDGET;
  if (priceCny <= 635) return weightG <= 2000 ? WH.SMALL : WH.BIG;
  return weightG <= 5000 ? WH.PREM_S : WH.PREM_B;
}

async function batched<T>(ids: string[], size: number, fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

export async function syncWarehouseBands(ozonClient: OzonClientLike): Promise<BandSyncResult> {
  const result: BandSyncResult = { checked: 0, migrated: [], skipped: [], errors: [] };

  // 1) 在售品（非归档）
  const list = (await ozonClient.request("POST", "/v3/product/list", {
    filter: { visibility: "ALL" }, limit: 1000,
  })) as { result?: { items?: Array<{ product_id: number; offer_id: string; archived: boolean }> } };
  const active = (list.result?.items || []).filter((i) => !i.archived);
  if (active.length === 0) return result;
  const offerIds = active.map((i) => i.offer_id);
  const pidByOffer = new Map(active.map((i) => [i.offer_id, i.product_id]));

  // 2) 价格 / 重量 / 库存（分批）
  const priceItems = await batched(offerIds, 100, async (chunk) => {
    const r = (await ozonClient.request("POST", "/v5/product/info/prices", {
      filter: { offer_id: chunk, visibility: "ALL" }, limit: 100,
    })) as { items?: Array<{ offer_id: string; price?: { price?: number | string } }> };
    return r.items || [];
  });
  const priceByOffer = new Map(priceItems.map((p) => [p.offer_id, Number(p.price?.price) || 0]));

  const attrItems = await batched(offerIds, 100, async (chunk) => {
    const r = (await ozonClient.request("POST", "/v4/product/info/attributes", {
      filter: { offer_id: chunk, visibility: "ALL" }, limit: 100,
    })) as { result?: Array<{ offer_id: string; weight?: number }> };
    return r.result || [];
  });
  const weightByOffer = new Map(attrItems.map((a) => [a.offer_id, Number(a.weight) || 0]));

  const stockItems = await batched(offerIds, 100, async (chunk) => {
    const r = (await ozonClient.request("POST", "/v4/product/info/stocks", {
      filter: { offer_id: chunk, visibility: "ALL" }, limit: 100,
    })) as { items?: Array<{ offer_id: string; stocks?: Array<{ type?: string; present?: number }> }> };
    return r.items || [];
  });
  const stockByOffer = new Map(
    stockItems.map((s) => [
      s.offer_id,
      (s.stocks || []).filter((x) => x.type === "rfbs").reduce((sum, x) => sum + (Number(x.present) || 0), 0),
    ]),
  );

  // 3) 逐品计算目标仓并幂等覆盖（分仓查询接口已下线，只能用全覆盖自纠正）
  const stocks: Array<{ offer_id: string; product_id: number; stock: number; warehouse_id: number }> = [];
  for (const offerId of offerIds) {
    result.checked++;
    const price = priceByOffer.get(offerId) || 0;
    const total = stockByOffer.get(offerId) || 0;
    const pid = pidByOffer.get(offerId);
    if (!pid || total <= 0 || price <= 0) {
      result.skipped.push(`${offerId}(price=${price},stock=${total})`);
      continue;
    }
    const target = targetWarehouse(price, weightByOffer.get(offerId) || 0);
    for (const wid of ALL_CEL) {
      stocks.push({ offer_id: offerId, product_id: pid, stock: wid === target ? total : 0, warehouse_id: wid });
    }
    result.migrated.push(`${offerId}→${target}(${price}¥/${weightByOffer.get(offerId) || 0}g/${total}件)`);
  }

  if (stocks.length === 0) return result;

  // 4) 批量写入（Ozon 单次上限 100 条）
  for (let i = 0; i < stocks.length; i += 100) {
    const resp = (await ozonClient.request("POST", "/v2/products/stocks", {
      stocks: stocks.slice(i, i + 100),
    })) as { result?: Array<{ offer_id?: string; updated?: boolean; errors?: unknown[] }> };
    for (const it of resp.result || []) {
      if (it.updated === false || (it.errors && it.errors.length > 0)) {
        result.errors.push(`${it.offer_id}: ${JSON.stringify(it.errors).slice(0, 150)}`);
      }
    }
  }

  logger.info({ ...result, migratedCount: result.migrated.length }, "Warehouse band sync complete");
  return result;
}
