// ============================================================
// astra 校验层（GPT astra 定价方案，2026-10 落地）
// 位置：planActions 输出动作后、executePlan 执行前（decision-engine 一行调用）。
// 只做拦截/修正，不重构 pricing/copy 主体流程；smart-pricing 模块不受影响。
//
// 条款对照（注释内引用 astra 方案原文）：
//  1. 零单识别（防"66T 降到死"）：零单不降价——没需求的品降价救不回来
//  2. 有优势不降价（防"61N 白降"）：现价 ≤ 竞品均价×0.98 不向下调
//  3. g_BE 盈亏平衡校验：让利所需流量增长倍率 g_BE = π(P)/π(p)，
//     无 GREEN 加持且预期流量增益达不到 g_BE → 减到临界值或 skip
//  4. RED 分级：翻绿降幅 ≤3% 优先试点 / 3-5% 分两步 / >5% 或破底价不追绿
//  5. 止损线：净利率 <20%（含退货5%）禁止扩大优惠；试验 14d 无订单证据回退
//
// 硬约束（与 decision-engine 既有机制叠加，不替代）：单次 ≤10%、每 SKU 24h ≤1 次、
// 叠加后 ≥ floorPrice、净利率 ≥20%（含退货 5%）。
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@onzo/logger";
import type { PlannedAction } from "./decision-engine.js";
import type { ProductScore } from "./scorer.js";

// ---- 口径常量 ----

/** 佣金率：与底价公式同口径（decision-engine scoreAllProducts 注释"佣金20%"） */
const COMMISSION_RATE = 0.20;
/** 退货计提（任务书硬约束：净利率含退货率 5%） */
const RETURN_RATE = 0.05;
/** 条款3：仅有 GREEN 时预期流量增益保守按 7.5% 计；无 GREEN 按 0 计 */
const GREEN_TRAFFIC_GAIN = parseFloat(process.env.PROMO_ASTRA_GREEN_GAIN || "0.075");
/** 条款1：访问数据不可得时的近似判定——连续 N 周期零单（默认 2）且已降价 ≥2 次 */
const ZERO_CYCLE_THRESHOLD = parseInt(process.env.PROMO_ASTRA_ZERO_CYCLES || "2", 10);
const MIN_DROPS_FOR_ZERO_STOP = 2;
/** 条款5：试验观察期（默认 14 天） */
const TRIAL_DAYS = parseInt(process.env.PROMO_ASTRA_TRIAL_DAYS || "14", 10);
/** 条款5 + 硬约束：净利率底线 20%（含退货） */
const NET_MARGIN_FLOOR = 0.20;
/** 条款4：翻绿降幅分档 */
const RED_PILOT_MAX = 0.03;  // ≤3% 优先试点
const RED_STEP_MAX = 0.05;   // 3-5% 分两步；>5% 不追绿

// ---- 类型 ----

/** 降价试验留档（条款5：试验前价格 + 起始时间 + 累计降价次数，供回退与条款1计数） */
export interface AstraTrial {
  preTrialPrice: number;
  startedAt: string; // ISO
  drops: number;
}

/** astra 运行状态（JSON 落盘持久化：试验要跨 14 天，进程重启不能丢） */
export interface AstraState {
  trials: Record<string, AstraTrial>;
  /** 连续零单决策周期计数（条款1 近似判定的"连续 N 周期"） */
  zeroCycles: Record<string, number>;
}

export interface AstraGuardContext {
  /** 近 14 天销量（recent=近7d，prev=前7d）；undefined 视为 0 单 */
  sales14d(offerId: string): { recent: number; prev: number } | undefined;
  /** 今日是否已调过该品（硬约束：每 SKU 每 24h ≤1 次调价） */
  isAdjustedToday(offerId: string): boolean;
  /** 有利指数 GREEN SKU 集合（Ozon 无公开 API，运营从后台「搜索推广」页人工维护后经 env 注入） */
  greenOffers: ReadonlySet<string>;
  state: AstraState;
}

// ---- 状态持久化 ----

export function emptyAstraState(): AstraState {
  return { trials: {}, zeroCycles: {} };
}

export function loadAstraState(filePath: string): AstraState {
  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AstraState>;
      return { trials: raw.trials || {}, zeroCycles: raw.zeroCycles || {} };
    }
  } catch (err) {
    logger.warn({ err, filePath }, "astra state load failed — starting fresh");
  }
  return emptyAstraState();
}

export function saveAstraState(filePath: string, state: AstraState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn({ err, filePath }, "astra state save failed");
  }
}

/**
 * 条款5（嵌入执行后回读）：降价执行成功后留档试验前价格，供 14d 无单回退。
 * decision-engine executePricingAction 成功分支一行调用；涨价（含回退）不记。
 * 多次降价 preTrialPrice 保持首次值——回退目标是"试验前"而非"上一次"。
 */
export function recordAstraTrial(
  state: AstraState, offerId: string, oldPrice: number, newPrice: number,
): void {
  if (!(newPrice < oldPrice)) return;
  const t = state.trials[offerId];
  if (t) {
    t.drops++;
  } else {
    state.trials[offerId] = { preTrialPrice: oldPrice, startedAt: new Date().toISOString(), drops: 1 };
  }
}

// ---- 单均利润（条款3 口径） ----

/** π(P) = P − 成本 − 佣金 − 退货计提 = P×(1−0.20−0.05) − costRub */
function unitProfit(price: number, costRub: number): number {
  return price * (1 - COMMISSION_RATE - RETURN_RATE) - costRub;
}

function orders14dOf(ctx: AstraGuardContext, offerId: string): number {
  const s = ctx.sales14d(offerId);
  return (s?.recent || 0) + (s?.prev || 0);
}

// ============================================================
// 主校验入口
// ============================================================

/**
 * astra 校验层主函数：对 planActions 的输出逐条拦截/修正，并追加止损回退动作。
 * 纯函数（副作用仅限 ctx.state 内计数/留档更新），不触碰 API。
 */
export function applyAstraGuard(
  actions: PlannedAction[],
  scored: ProductScore[],
  ctx: AstraGuardContext,
): PlannedAction[] {
  const byOffer = new Map(scored.map((p) => [p.offerId, p]));

  // 每轮刷新连续零单周期计数（条款1 的"连续 N 周期"；有单即清零）
  for (const p of scored) {
    ctx.state.zeroCycles[p.offerId] = orders14dOf(ctx, p.offerId) === 0
      ? (ctx.state.zeroCycles[p.offerId] || 0) + 1
      : 0;
  }

  // 试验结案清理（条款5）：出单 → 试验成功；价格已回到试验前（±1% 容差）→ 回退完成
  for (const [offerId, trial] of Object.entries(ctx.state.trials)) {
    if (orders14dOf(ctx, offerId) > 0) {
      delete ctx.state.trials[offerId];
      logger.info({ offerId }, "astra trial closed: orders observed — experiment succeeded");
      continue;
    }
    const p = byOffer.get(offerId);
    if (p && p.currentPrice >= trial.preTrialPrice * 0.99) {
      delete ctx.state.trials[offerId];
      logger.info({ offerId }, "astra trial closed: price reverted to pre-trial level");
    }
  }

  const guarded: PlannedAction[] = [];
  for (const action of actions) {
    const p = byOffer.get(action.offerId);
    // 无评分数据、copy 动作、涨价动作（利润修复/优势涨价/回退）→ 直通：
    // astra 五条款只约束"向下调价/加入弹性提升"（引擎无弹性提升动作类型，统一作用于向下调价）
    if (!p || !action.suggestedPrice || action.suggestedPrice >= action.currentPrice) {
      guarded.push(action);
      continue;
    }
    const verdict = guardPriceDrop(action, p, ctx);
    if (verdict) guarded.push(verdict); // null = 整条剔除
  }

  // 条款5 止损回退：试验 ≥14d 无订单证据 → 回退到试验前价格（分步，单次 ≤10% 硬约束）
  const inPlan = new Set(guarded.map((a) => a.offerId));
  for (const [offerId, trial] of Object.entries(ctx.state.trials)) {
    const p = byOffer.get(offerId);
    if (!p || inPlan.has(offerId)) continue;
    if (orders14dOf(ctx, offerId) > 0) continue;
    const ageDays = (Date.now() - new Date(trial.startedAt).getTime()) / 86_400_000;
    if (ageDays < TRIAL_DAYS) continue;
    if (ctx.isAdjustedToday(offerId)) continue; // 每 SKU 24h ≤1 次
    const target = Math.min(trial.preTrialPrice, Math.floor(p.currentPrice * 1.10));
    if (target <= p.currentPrice) continue;
    logger.info({ offerId, from: p.currentPrice, to: target, preTrialPrice: trial.preTrialPrice, ageDays },
      "astra clause5: reverting price-drop trial after 14d without orders");
    guarded.push({
      offerId,
      name: p.name,
      storeId: p.storeId,
      storeName: p.storeName,
      type: "pricing",
      suggestedPrice: target,
      currentPrice: p.currentPrice,
      priority: 0, // high：止损优先
      reason: `astra条款5止损回退：降价试验${Math.floor(ageDays)}d无订单证据，回退到试验前价格 ${trial.preTrialPrice.toFixed(0)}₽（本轮 ${p.currentPrice.toFixed(0)}→${target}₽，单次≤10%分步）`,
    });
  }

  // 高优先级（RED≤3% 试点 / 止损回退，priority=0）排最前；重排后按执行顺序重编号
  guarded.sort((a, b) => a.priority - b.priority);
  guarded.forEach((a, i) => { a.priority = i + 1; });
  return guarded;
}

// ============================================================
// 单条向下调价的条款 1→2→4→3→5 校验
// ============================================================

/** 返回修正后的 action；null = 整条剔除；copy_and_pricing 被剔 pricing 时降级为 copy */
function guardPriceDrop(
  action: PlannedAction,
  p: ProductScore,
  ctx: AstraGuardContext,
): PlannedAction | null {
  let suggested = action.suggestedPrice as number; // 调用方已保证存在且 < currentPrice
  const cur = p.currentPrice;

  const dropPricing = (reason: string): PlannedAction | null => {
    logger.info({ offerId: p.offerId, from: cur, to: suggested, reason }, "astra guard: price drop rejected");
    if (action.type === "copy_and_pricing") {
      return { ...action, type: "copy", suggestedPrice: undefined, reason: `${action.reason} | ${reason}` };
    }
    return null;
  };

  // 条款1 零单识别（防"66T 降到死"）：访问数据不可得，按方案降级口径近似判定——
  // 近14d订单=0 且 连续≥N周期零单 且 已降价≥2次 → 需求止损：零单不降价
  const zeroCycles = ctx.state.zeroCycles[p.offerId] || 0;
  const drops = ctx.state.trials[p.offerId]?.drops || 0;
  if (orders14dOf(ctx, p.offerId) === 0 && zeroCycles >= ZERO_CYCLE_THRESHOLD && drops >= MIN_DROPS_FOR_ZERO_STOP) {
    return dropPricing(`astra条款1需求止损：连续${zeroCycles}周期零单且已降价${drops}次，零单不降价（没需求的品降价救不回来）`);
  }

  // 条款2 有优势不降价（防"61N 白降"）：现价 ≤ 竞品均价×0.98 →
  // 价格本有优势，0 转化不是价格问题，再降白亏利润
  if (p.competitorAvg > 0 && cur <= p.competitorAvg * 0.98) {
    return dropPricing(`astra条款2有优势不降价：现价${cur.toFixed(0)}₽ ≤ 竞品均价×0.98（${(p.competitorAvg * 0.98).toFixed(0)}₽），再降白亏利润`);
  }

  // 条款4 RED 分级：翻绿所需降幅 d =（现价 → 竞品均价×0.97）
  // （条款2 之后必有 cur > 竞品×0.98 > 竞品×0.97，d>0；无竞品数据时竞品均价=现价 fallback，此块不进入）
  if (p.competitorAvg > 0) {
    const greenTarget = p.competitorAvg * 0.97;
    const d = (cur - greenTarget) / cur;
    if (d > RED_STEP_MAX || greenTarget < p.floorPrice) {
      return dropPricing(
        `astra条款4 RED不追绿：翻绿需降${(d * 100).toFixed(1)}%${greenTarget < p.floorPrice ? "且翻绿价破底价" : ""}（>5%），转「退出弹性提升评估」`,
      );
    }
    if (d > RED_PILOT_MAX) {
      // 3-5% 分两步：本轮先降一半，下周期评估
      suggested = Math.round(cur * (1 - d / 2));
      action = { ...action, reason: `${action.reason} | astra条款4 RED ${(d * 100).toFixed(1)}% 分两步：本轮先降一半至 ${suggested}₽，下周期评估` };
    } else {
      // ≤3% 优先试点，标记 high 优先级
      action = { ...action, priority: 0, reason: `${action.reason} | astra条款4 RED≤3% 优先试点（high）` };
    }
  }

  // 条款3 g_BE 盈亏平衡校验（弹性提升让利）：
  // g_BE = π(P)/π(p)；预期流量增益保守估计——仅 GREEN 按 7.5% 计，无 GREEN 按 0 计
  const piCur = unitProfit(cur, p.costRub);
  const piNew = unitProfit(suggested, p.costRub);
  if (piNew <= 0) {
    return dropPricing(`astra条款3 g_BE：新价单均利润 ${piNew.toFixed(0)}₽ ≤0，降价即亏损`);
  }
  if (piCur <= 0) {
    return dropPricing(`astra条款3 g_BE：现价单均利润 ${piCur.toFixed(0)}₽ ≤0，应走利润修复（提价）而非降价`);
  }
  const gBE = piCur / piNew;
  const gain = ctx.greenOffers.has(p.offerId) ? GREEN_TRAFFIC_GAIN : 0;
  if (gBE > 1 + gain) {
    // 不允许该幅度 → 幅度减到 g_BE 可达的临界值：π(p_crit) = π(P)/(1+gain)
    const pCrit = Math.ceil((piCur / (1 + gain) + p.costRub) / (1 - COMMISSION_RATE - RETURN_RATE));
    if (pCrit >= cur || pCrit < p.floorPrice) {
      return dropPricing(
        `astra条款3 g_BE=${gBE.toFixed(3)} > 1+预期流量增益${(gain * 100).toFixed(1)}%：${gain === 0 ? "无GREEN加持增益按0计，临界降幅为0" : "临界价破底价"}，不允许该幅度降价`,
      );
    }
    suggested = pCrit;
    action = { ...action, reason: `${action.reason} | astra条款3 g_BE=${gBE.toFixed(3)}：幅度减到临界值 ${pCrit}₽（g_BE≤1+${(gain * 100).toFixed(1)}%）` };
  }

  // 条款5 止损线：净利率 <20%（含退货5%）禁止扩大优惠 → 提到净利率20%水位
  const pMarginMin = Math.ceil(p.costRub / (1 - COMMISSION_RATE - RETURN_RATE - NET_MARGIN_FLOOR));
  if (suggested < pMarginMin) {
    if (pMarginMin >= cur) {
      return dropPricing(`astra条款5净利率止损：20%水位 ${pMarginMin}₽ ≥ 现价，禁止扩大优惠`);
    }
    suggested = Math.max(pMarginMin, p.floorPrice);
    action = { ...action, reason: `${action.reason} | astra条款5净利率止损：提到 ${suggested}₽（净利率≥20%，含退货5%）` };
  }

  // 硬约束兜底：全优惠叠加后 ≥ floorPrice；修正后与现价持平/更高 → 无降价意义
  if (suggested < p.floorPrice) {
    return dropPricing(`astra修正价 ${suggested}₽ 破底价 ${p.floorPrice}₽，剔除`);
  }
  if (suggested >= cur) return null;

  return { ...action, suggestedPrice: suggested };
}
