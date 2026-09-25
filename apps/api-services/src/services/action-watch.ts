// ============================================================
// Action Watch — 促销活动监控（/v2/actions/* 新接口，2026-09-25 接入）
// 监控点：①is_quarantined 价格冻结 ②action_price 超 max_action_price >10%（促销不利/将被移除预警）
// 背景：全 6 品在"弹性提升"（action_id 1977747）自动参与中；67F-02 叶轮曾超限 13%（价格不利实证）
// ============================================================

import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { logger } from "@onzo/logger";

interface ActionProduct {
  id: number;
  action_price?: { amount?: string };
  max_action_price?: { amount?: string };
  current_boost?: number;
  is_quarantined?: boolean;
}

interface ActionProductsResp {
  products?: ActionProduct[];
}

/** 监控的促销活动（env ACTION_WATCH_IDS 可覆盖，逗号分隔） */
function watchActionIds(): number[] {
  const env = process.env.ACTION_WATCH_IDS || "1977747";
  return env.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
}

export async function runActionWatch(ozonClient: OzonClient): Promise<{ checked: number; alerts: string[] }> {
  const alerts: string[] = [];
  let checked = 0;

  for (const actionId of watchActionIds()) {
    let resp: ActionProductsResp;
    try {
      resp = await ozonClient.request<ActionProductsResp>("POST", "/v2/actions/products", { action_id: actionId, limit: 100 });
    } catch (err) {
      logger.warn({ actionId, err: (err as Error).message }, "ActionWatch: query failed");
      continue;
    }
    const items = resp.products || [];
    checked += items.length;

    for (const p of items) {
      const pid = p.id;
      if (p.is_quarantined) {
        alerts.push(`🚨 促销价格冻结：product ${pid} 被 Ozon 冻结（is_quarantined）——商品 ${pid} 在促销 ${actionId} 中价格被冻结，需到后台价格页解冻`);
      }
      const ap = parseFloat(p.action_price?.amount || "0");
      const mp = parseFloat(p.max_action_price?.amount || "0");
      if (ap > 0 && mp > 0 && ap > mp * 1.1) {
        const pct = Math.round(((ap - mp) / mp) * 1000) / 10;
        alerts.push(`⚠️ 促销限价超标：product ${pid} action_price ${ap}₽ > max ${mp}₽（超 ${pct}%）——促销 ${actionId} 中该商品"价格不利"，将被降权/移除，建议调价或退出促销`);
      }
    }
  }

  logger.info({ checked, alertCount: alerts.length }, "ActionWatch: cycle complete");
  return { checked, alerts };
}
