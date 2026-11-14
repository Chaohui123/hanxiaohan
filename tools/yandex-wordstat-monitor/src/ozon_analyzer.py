from __future__ import annotations

from datetime import date, timedelta
import hashlib
import math
import re
import statistics
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import quote_plus

from src.models import (
    FreshnessStatus,
    KeywordObservation,
    ReferenceCityMetric,
    ScoreBreakdown,
    SeasonalityHint,
    VolumeBandStatus,
    WordstatDynamicsResponseNormalized,
    WordstatRegionsResponseNormalized,
    WordstatTopResponseNormalized,
)

RU_STOPWORDS: Set[str] = {"для", "в", "на", "с", "и", "из", "под", "по", "к", "от", "без"}
RU_SUFFIX_PATTERN = re.compile(
    r"(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ей|ий|ый|ой|ая|яя|ое|ее|ые|ие|ам|ям|ом|ем|ую|юю|ия|ье|ья|а|я|ы|и|у|ю|е|о)$"
)


def normalize_ru_text(text: str) -> str:
    cleaned = text.lower().replace("ё", "е").replace("×", "х").replace("x", "х")
    cleaned = re.sub(r"[^а-яa-z0-9\sх-]", " ", cleaned)
    return " ".join(cleaned.split())


def extract_ru_stems(phrase: str) -> Set[str]:
    norm = normalize_ru_text(phrase)
    stems: Set[str] = set()
    for tok in norm.split():
        if tok in RU_STOPWORDS or len(tok) <= 1:
            continue
        stem = RU_SUFFIX_PATTERN.sub("", tok) if len(tok) >= 5 else tok
        stems.add(stem if len(stem) >= 2 else tok)
    return stems


def jaccard_similarity(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def build_search_urls(phrase: str) -> Tuple[str, str]:
    encoded = quote_plus(phrase.strip())
    yandex_url = f"https://yandex.ru/search/?text={encoded}"
    ozon_url = f"https://www.ozon.ru/search/?text={encoded}&from_global=true"
    return yandex_url, ozon_url


class OzonWordstatAnalyzer:
    def __init__(self, config: Dict[str, Any], run_date: str) -> None:
        self.config = config
        self.run_date = date.fromisoformat(run_date)
        self.thresholds = config.get("observationThresholds", {})
        self.scoring_cfg = config.get("scoring", {})
        self.seasonality_cfg = config.get("seasonality", {})
        self.gov_cfg = config.get("governanceRules", {})
        self.ref_cities = config.get("wordstat", {}).get(
            "referenceCities",
            [
                {"id": 213, "nameRu": "Москва", "nameZh": "莫斯科"},
                {"id": 2, "nameRu": "Санкт-Петербург", "nameZh": "圣彼得堡"},
                {"id": 54, "nameRu": "Екатеринбург", "nameZh": "叶卡捷琳堡"},
            ],
        )

    def _check_governance_disposition(self, phrase: str) -> Tuple[str, Optional[str]]:
        norm = normalize_ru_text(phrase)
        for item in self.gov_cfg.get("terminatedDirections", []):
            pat = normalize_ru_text(item["pattern"])
            if pat and pat in norm:
                return "blocked_terminated_direction", item["reason"]

        for item in self.gov_cfg.get("existingPortfolioExclusions", []):
            pat = normalize_ru_text(item["pattern"])
            if pat and pat in norm:
                return "excluded_existing_portfolio", item["reason"]

        for noise_tok in self.gov_cfg.get("nonPurchaseNoiseTokens", []):
            nt = normalize_ru_text(noise_tok)
            if re.search(rf"(?:^|\s){re.escape(nt)}(?:$|\s)", norm):
                return (
                    "filtered_non_purchase_noise",
                    f"命中非购买意图查询噪声词 '{noise_tok}'，不代表商品购买需求",
                )

        return "eligible_observation", None

    def _evaluate_intent_and_brands(self, phrase: str) -> Tuple[str, List[str], Optional[str]]:
        norm = normalize_ru_text(phrase)
        brands_hit: List[str] = []
        for b_tok in self.gov_cfg.get("brandWatchTokens", []):
            bt = normalize_ru_text(b_tok)
            if re.search(rf"(?:^|\s){re.escape(bt)}(?:$|\s)", norm):
                brands_hit.append(b_tok)

        brand_note = None
        if brands_hit:
            brand_note = (
                f"查询含品牌/平台关联词 ({', '.join(brands_hit)})：此标记仅作流量归因与合规核查提示，"
                "不直接等同于法律侵权结论；但严禁未经授权将他人商标词直接写入 Ozon 商品标题或属性。"
            )

        commercial_hits = sum(
            1
            for c_tok in self.gov_cfg.get("commercialIntentBoostTokens", [])
            if normalize_ru_text(c_tok) in norm
        )
        intent_status = "commercial_plausible" if commercial_hits >= 1 else "mixed_needs_seller_verify"
        return intent_status, brands_hit, brand_note

    def _evaluate_freshness(self, source_as_of: Optional[str]) -> Tuple[Optional[int], FreshnessStatus, float]:
        if not source_as_of:
            return None, "no_data", 0.0
        as_of_dt = date.fromisoformat(source_as_of)
        lag_days = (self.run_date - as_of_dt).days
        fresh_max = int(self.thresholds.get("freshMaxLagDays", 14))
        warn_max = int(self.thresholds.get("laggingWarnMaxLagDays", 35))
        stale_hold = int(self.thresholds.get("staleHoldAfterLagDays", 56))

        if lag_days <= fresh_max:
            return lag_days, "fresh", 1.0
        if lag_days <= warn_max:
            return lag_days, "lagging_notice", 0.85
        if lag_days <= stale_hold:
            return lag_days, "lagging_significant", 0.70
        return lag_days, "stale_expired", 0.0

    def _map_trend_score(self, blended_growth: float) -> float:
        clip_min = float(self.scoring_cfg.get("wowClipMin", -0.50))
        clip_max = float(self.scoring_cfg.get("wowClipMax", 1.50))
        g = max(clip_min, min(clip_max, blended_growth))
        if g <= 0.0:
            return round(45.0 * (g - clip_min) / max(0.01, -clip_min), 2)
        if g <= 0.30:
            return round(45.0 + (g / 0.30) * 30.0, 2)
        return round(min(100.0, 75.0 + ((g - 0.30) / max(0.01, clip_max - 0.30)) * 25.0), 2)

    @staticmethod
    def _map_affinity_score(weighted_affinity: float) -> float:
        if weighted_affinity <= 60.0:
            return 0.0
        if weighted_affinity <= 100.0:
            return round(((weighted_affinity - 60.0) / 40.0) * 40.0, 2)
        if weighted_affinity <= 150.0:
            return round(40.0 + ((weighted_affinity - 100.0) / 50.0) * 40.0, 2)
        if weighted_affinity <= 210.0:
            return round(80.0 + ((weighted_affinity - 150.0) / 60.0) * 20.0, 2)
        return 100.0

    def _compute_stability_score(self, dynamics: WordstatDynamicsResponseNormalized) -> Optional[float]:
        if dynamics.period != "weekly" or len(dynamics.results) < int(self.thresholds.get("minValidWeeksForScoring", 4)):
            return None
        recent = dynamics.results[-12:]
        counts = [p.count for p in recent if p.count > 0]
        if len(counts) < 4:
            return None

        span_days = (date.fromisoformat(recent[-1].date) - date.fromisoformat(recent[0].date)).days
        expected_weeks = max(len(recent), (span_days // 7) + 1)
        coverage_ratio = min(1.0, len(recent) / max(1, expected_weeks))

        med = statistics.median(counts)
        if med <= 0:
            return 0.0
        sorted_c = sorted(counts)
        q1 = sorted_c[len(sorted_c) // 4]
        q3 = sorted_c[(3 * len(sorted_c)) // 4]
        iqr_cv = (q3 - q1) / med
        raw_score = max(0.0, min(100.0, 100.0 * (1.0 - min(iqr_cv, 1.2) / 1.2)))
        return round(raw_score * coverage_ratio, 2)

    def _evaluate_seasonality(
        self,
        dynamics: Optional[WordstatDynamicsResponseNormalized],
        freshness_status: FreshnessStatus,
    ) -> SeasonalityHint:
        allowed_actions = [
            "Ozon Seller 真实搜索词批次核验（当前原生7天199页9949条，自建累计7/28天，核查真实点击与转化）",
            "1688/供应链起订量、交期与合规资质评估（仅评估寻源，不提前囤货）",
            "俄语商品卡8图双视频脚本与关键参数草稿准备",
        ]
        prohibited_actions = [
            "严禁把季节性提示当作提前备货压库指令（无货源模式不出单不拿样，出单拿样按现行SOP执行）",
            "严禁未经真实单元经济核算与独立人工复核直接创建或上架SKU",
        ]

        if not dynamics or dynamics.period != "weekly" or freshness_status in ("no_data", "stale_expired"):
            return SeasonalityHint(
                status="stale_or_missing_series",
                uncertaintyNote="缺少有效周粒度时间序列或数据已超期，禁止猜测季节波峰。",
                allowedPreparationActions=allowed_actions,
                prohibitedActions=prohibited_actions,
            )

        min_hist_weeks = int(self.seasonality_cfg.get("minHistoricalWeeksRequired", 44))
        if len(dynamics.results) < min_hist_weeks:
            return SeasonalityHint(
                status="insufficient_yoy_history",
                basisSourceAsOf=dynamics.sourceAsOf,
                uncertaintyNote=(
                    f"已返回有效周数 ({len(dynamics.results)}周) 少于同比评估最低要求 ({min_hist_weeks}周)，"
                    "不输出波峰倒计时估计。"
                ),
                allowedPreparationActions=allowed_actions,
                prohibitedActions=prohibited_actions,
            )

        lead_min_w = int(self.seasonality_cfg.get("targetPeakLeadWeeksMin", 8))
        lead_max_w = int(self.seasonality_cfg.get("targetPeakLeadWeeksMax", 14))
        target_yoy_start = self.run_date + timedelta(weeks=lead_min_w) - timedelta(days=364)
        target_yoy_end = self.run_date + timedelta(weeks=lead_max_w) - timedelta(days=364)

        window_points = [
            p for p in dynamics.results if target_yoy_start <= date.fromisoformat(p.date) <= target_yoy_end
        ]
        expected_window_weeks = max(1, lead_max_w - lead_min_w + 1)
        coverage = len(window_points) / expected_window_weeks
        if coverage < float(self.seasonality_cfg.get("minWindowCoverageRatio", 0.85)):
            return SeasonalityHint(
                status="insufficient_yoy_history",
                basisSourceAsOf=dynamics.sourceAsOf,
                uncertaintyNote="去年同期目标观察窗口存在周次缺失，不伪造波峰时间估计。",
                allowedPreparationActions=allowed_actions,
                prohibitedActions=prohibited_actions,
            )

        all_counts = [p.count for p in dynamics.results if p.count > 0]
        overall_median = statistics.median(all_counts) if all_counts else 0
        peak_pt = max(window_points, key=lambda p: p.count)
        prominence = float(self.seasonality_cfg.get("peakProminenceMultiplier", 1.35))

        if overall_median > 0 and peak_pt.count >= overall_median * prominence:
            next_anniv_dt = date.fromisoformat(peak_pt.date) + timedelta(days=364)
            est_days_center = (next_anniv_dt - self.run_date).days
            est_weeks = round(est_days_center / 7)
            days_band = [max(0, est_days_center - 7), est_days_center + 7]
            return SeasonalityHint(
                status="upcoming_peak_window",
                estimatedWeeksToPeak=est_weeks,
                estimatedDaysBand=days_band,
                historicalPeakWeekStart=peak_pt.date,
                historicalPeakCount=peak_pt.count,
                basisSourceAsOf=dynamics.sourceAsOf,
                uncertaintyNote=(
                    f"基于去年波峰周 ({peak_pt.date}) 按周粒度外推，预计约 {est_weeks} 周（区间 {days_band[0]}~{days_band[1]} 天，"
                    f"含周粒度 ±7 天固有误差；当前序列截止 {dynamics.sourceAsOf}），仅用于补证与准备，非精确到日预测。"
                ),
                allowedPreparationActions=allowed_actions,
                prohibitedActions=prohibited_actions,
            )

        return SeasonalityHint(
            status="outside_60_90d_window",
            basisSourceAsOf=dynamics.sourceAsOf,
            uncertaintyNote="去年同期 8~14 周（约60~90天）窗口内未检测到显著季节波峰。",
            allowedPreparationActions=allowed_actions,
            prohibitedActions=prohibited_actions,
        )

    def analyze_keyword(
        self,
        phrase: str,
        zh_draft: str,
        category: str,
        seed_status: str,
        requested_from: str,
        requested_to: str,
        top_resp: Optional[WordstatTopResponseNormalized],
        dynamics_resp: Optional[WordstatDynamicsResponseNormalized],
        regions_resp: Optional[WordstatRegionsResponseNormalized],
    ) -> KeywordObservation:
        yandex_url, ozon_url = build_search_urls(phrase)
        stems = sorted(extract_ru_stems(phrase))
        cluster_seed = "|".join(stems) if stems else normalize_ru_text(phrase)
        concept_cluster_id = hashlib.sha1(cluster_seed.encode("utf-8")).hexdigest()[:10]

        disposition, disp_reason = self._check_governance_disposition(phrase)
        intent_status, brand_flags, brand_note = self._evaluate_intent_and_brands(phrase)
        if disposition == "filtered_non_purchase_noise":
            intent_status = "non_commercial_noise"

        warnings: List[str] = []
        if seed_status != "verified_seed_for_observation":
            warnings.append("该词为预设待核示例或Top结果扩词观察项，尚未经 Ozon Seller 转化验证，非选品结论。")
        if brand_note:
            warnings.append(brand_note)

        source_as_of = dynamics_resp.sourceAsOf if dynamics_resp else None
        lag_days, freshness_status, freshness_factor = self._evaluate_freshness(source_as_of)
        caliber = dynamics_resp.caliber if dynamics_resp else "weekly_plus_only"

        if freshness_status in ("lagging_notice", "lagging_significant") and source_as_of:
            warnings.append(
                f"Wordstat 周序列实际最后返回日期为 {source_as_of}（请求截止 {requested_to}，滞后 {lag_days} 天）；"
                "缺失尾部周不补0，亦严禁将历史滞后周冒充当前周飙升。"
            )
        elif freshness_status == "stale_expired":
            warnings.append(f"数据严重滞后 ({lag_days} 天，截止 {source_as_of})，已冻结观察分排序。")
        elif freshness_status == "no_data":
            warnings.append("Wordstat dynamics 未返回有效数据点，禁止补0或自动判合格。")

        effective_vol: Optional[int] = None
        median_4w: Optional[float] = None
        wow_rate: Optional[float] = None
        short_base_growth: Optional[float] = None
        trend_score: Optional[float] = None

        if dynamics_resp and dynamics_resp.results:
            pts = dynamics_resp.results
            effective_vol = pts[-1].count
            if dynamics_resp.period == "weekly":
                last_4_counts = [p.count for p in pts[-4:] if p.count >= 0]
                if last_4_counts:
                    median_4w = round(float(statistics.median(last_4_counts)), 1)
                if len(pts) >= 2:
                    d_last = date.fromisoformat(pts[-1].date)
                    d_prev = date.fromisoformat(pts[-2].date)
                    if (d_last - d_prev).days == 7 and pts[-2].count > 0:
                        wow_rate = round((pts[-1].count - pts[-2].count) / pts[-2].count, 4)
                        prior_slice = [p.count for p in pts[-5:-1] if p.count > 0]
                        prior_med = statistics.median(prior_slice) if prior_slice else float(pts[-2].count)
                        short_base_growth = round((pts[-1].count - prior_med) / prior_med, 4) if prior_med > 0 else wow_rate
                        blended = 0.6 * wow_rate + 0.4 * short_base_growth
                        trend_score = self._map_trend_score(blended)
                    else:
                        warnings.append("最近两个返回周之间不连续（存在缺失周）或前值为0，已拒绝伪造 WoW 环比。")
            else:
                warnings.append(f"当前序列口径为 {caliber}，不与标准 weekly 口径混合计算周环比。")

        min_band = int(self.thresholds.get("minWeeklyVolumeBand", 2000))
        max_band = int(self.thresholds.get("maxWeeklyVolumeBand", 80000))
        if effective_vol is None:
            vol_band_status: VolumeBandStatus = "unknown_volume"
            sample_factor = 0.0
        elif effective_vol < min_band:
            vol_band_status = "below_observation_band"
            sample_factor = round(min(1.0, math.sqrt(max(0, effective_vol) / float(min_band))), 4)
            warnings.append(
                f"有效周搜索量 ({effective_vol}) 低于常规观察带下限 ({min_band})：不自动删除需求，"
                "但已折减样本置信度，且低搜索量不自动等于蓝海。"
            )
        elif effective_vol > max_band:
            vol_band_status = "above_observation_band"
            sample_factor = 1.0
            warnings.append(
                f"有效周搜索量 ({effective_vol}) 高于常规观察带上限 ({max_band})：高搜索量不自动等于竞争激烈，"
                "但宽泛大词严禁直接选SKU，必须下钻细分属性词并在 Seller 后台核实。"
            )
        else:
            vol_band_status = "within_observation_band"
            sample_factor = 1.0

        ref_city_metrics: List[ReferenceCityMetric] = []
        weighted_aff_num = 0.0
        weighted_aff_den = 0
        reg_lookup = {r.region: r for r in (regions_resp.results if regions_resp else [])}
        for city_cfg in self.ref_cities:
            cid = int(city_cfg["id"])
            matched = reg_lookup.get(cid)
            if matched:
                ref_city_metrics.append(
                    ReferenceCityMetric(
                        regionId=cid,
                        nameRu=city_cfg["nameRu"],
                        nameZh=city_cfg["nameZh"],
                        count=matched.count,
                        rawShare=matched.share,
                        affinityIndex=matched.affinityIndex,
                    )
                )
                if matched.count > 0 and matched.affinityIndex is not None:
                    weighted_aff_num += matched.count * matched.affinityIndex
                    weighted_aff_den += matched.count
            else:
                ref_city_metrics.append(
                    ReferenceCityMetric(
                        regionId=cid,
                        nameRu=city_cfg["nameRu"],
                        nameZh=city_cfg["nameZh"],
                        count=None,
                        rawShare=None,
                        affinityIndex=None,
                    )
                )

        weighted_ref_affinity = round(weighted_aff_num / weighted_aff_den, 3) if weighted_aff_den > 0 else None
        city_affinity_score = self._map_affinity_score(weighted_ref_affinity) if weighted_ref_affinity is not None else None
        stability_score = self._compute_stability_score(dynamics_resp) if dynamics_resp else None

        score_breakdown = self._build_composite_score(
            disposition=disposition,
            freshness_status=freshness_status,
            freshness_factor=freshness_factor,
            sample_factor=sample_factor,
            trend_score=trend_score,
            city_affinity_score=city_affinity_score,
            stability_score=stability_score,
        )

        seasonality = self._evaluate_seasonality(dynamics_resp, freshness_status)
        associations = (top_resp.associations[:10] if top_resp and top_resp.associations else [])
        if associations:
            warnings.append("Wordstat associations 关联词仅作为扩词候选参考，绝不等同于真实购买需求。")

        return KeywordObservation(
            phrase=phrase,
            zhDraft=zh_draft,
            category=category,
            seedStatus=seed_status,
            conceptClusterId=concept_cluster_id,
            disposition=disposition,
            dispositionReason=disp_reason,
            purchaseIntentStatus=intent_status,
            brandRiskFlags=brand_flags,
            brandLegalNote=brand_note,
            caliber=caliber,
            requestedFromDate=requested_from,
            requestedToDate=requested_to,
            sourceAsOf=source_as_of,
            lagDaysFromRun=lag_days,
            freshnessStatus=freshness_status,
            effectiveWeeklyVolume=effective_vol,
            median4wVolume=median_4w,
            volumeBandStatus=vol_band_status,
            wowRate=wow_rate,
            shortBaselineGrowthRate=short_base_growth,
            referenceCities=ref_city_metrics,
            weightedReferenceAffinity=weighted_ref_affinity,
            expansionAssociations=associations,
            score=score_breakdown,
            seasonality=seasonality,
            yandexSearchUrl=yandex_url,
            ozonSearchUrl=ozon_url,
            warnings=warnings,
        )

    def _build_composite_score(
        self,
        disposition: str,
        freshness_status: FreshnessStatus,
        freshness_factor: float,
        sample_factor: float,
        trend_score: Optional[float],
        city_affinity_score: Optional[float],
        stability_score: Optional[float],
    ) -> ScoreBreakdown:
        if disposition != "eligible_observation":
            return ScoreBreakdown(
                observationPriorityScore=None,
                scoreStatus="not_applicable_blocked",
                trendScore=trend_score,
                cityAffinityScore=city_affinity_score,
                stabilityScore=stability_score,
                freshnessFactor=freshness_factor,
                sampleConfidenceFactor=sample_factor,
                explanation=["该词属于历史已终止方向、已有品线排除或非购买噪声，不参与选品观察排序。"],
            )

        if freshness_status in ("stale_expired", "no_data"):
            return ScoreBreakdown(
                observationPriorityScore=None,
                scoreStatus="stale_hold" if freshness_status == "stale_expired" else "insufficient_data",
                trendScore=trend_score,
                cityAffinityScore=city_affinity_score,
                stabilityScore=stability_score,
                freshnessFactor=freshness_factor,
                sampleConfidenceFactor=sample_factor,
                explanation=["缺少有效新鲜周序列或滞后超限，拒绝填0伪造观察分。"],
            )

        weights_cfg = self.scoring_cfg.get("weights", {})
        components = [
            ("trendMomentum", float(weights_cfg.get("trendMomentum", 0.40)), trend_score),
            ("referenceCityAffinity", float(weights_cfg.get("referenceCityAffinity", 0.30)), city_affinity_score),
            ("demandStability", float(weights_cfg.get("demandStability", 0.30)), stability_score),
        ]
        valid = [(name, w, val) for name, w, val in components if val is not None]
        if len(valid) < 2:
            return ScoreBreakdown(
                observationPriorityScore=None,
                scoreStatus="insufficient_data",
                trendScore=trend_score,
                cityAffinityScore=city_affinity_score,
                stabilityScore=stability_score,
                freshnessFactor=freshness_factor,
                sampleConfidenceFactor=sample_factor,
                explanation=["有效评分维度不足2项（禁止将缺失维度补0），标记为数据不足待人工核查。"],
            )

        weight_sum = sum(w for _, w, _ in valid)
        normalized_terms = [(name, (w / weight_sum) * val) for name, w, val in valid]
        raw_composite = sum(term for _, term in normalized_terms)

        max_dom_ratio = float(self.scoring_cfg.get("maxSingleComponentContributionRatio", 0.55))
        dominance_capped = False
        explanation: List[str] = []

        if raw_composite > 0:
            other_terms_map = {
                name: sum(t for other_name, t in normalized_terms if other_name != name)
                for name, _ in normalized_terms
            }
            capped_terms: List[float] = []
            for name, term in normalized_terms:
                others = other_terms_map[name]
                if term / raw_composite > max_dom_ratio:
                    dominance_capped = True
                    max_allowed_term = (max_dom_ratio / (1.0 - max_dom_ratio)) * max(others, 5.0)
                    capped_terms.append(min(term, max_allowed_term))
                else:
                    capped_terms.append(term)
            if dominance_capped:
                raw_composite = sum(capped_terms)
                explanation.append(f"触发单指标主导上限约束 (>{int(max_dom_ratio * 100)}%)，已抑制极端单一指标拉高总分。")

        partial_multiplier = 1.0
        score_status = "scored_full"
        if len(valid) < 3:
            partial_multiplier = float(self.scoring_cfg.get("partialComponentCapMultiplier", 0.85))
            score_status = "scored_partial_reweighted"
            explanation.append("存在1项子维度缺失（不填0），按剩余有效维度重归一化并施加 0.85 完整度折减。")

        final_score = round(raw_composite * partial_multiplier * freshness_factor * sample_factor, 2)
        explanation.append(
            "观察优先级分仅用于运营周报人工复核排队，绝非最终选品机会分或上架授权。"
        )

        return ScoreBreakdown(
            observationPriorityScore=final_score,
            scoreStatus=score_status,
            trendScore=trend_score,
            cityAffinityScore=city_affinity_score,
            stabilityScore=stability_score,
            freshnessFactor=freshness_factor,
            sampleConfidenceFactor=sample_factor,
            singleMetricDominanceCapped=dominance_capped,
            explanation=explanation,
        )

    def cluster_and_rank_top_observations(
        self,
        observations: List[KeywordObservation],
    ) -> Tuple[List[KeywordObservation], List[KeywordObservation]]:
        eligible = [o for o in observations if o.disposition == "eligible_observation"]
        blocked = [o for o in observations if o.disposition != "eligible_observation"]

        eligible_sorted = sorted(
            eligible,
            key=lambda x: (
                x.score.observationPriorityScore is not None,
                x.score.observationPriorityScore or -1.0,
                x.effectiveWeeklyVolume or -1,
            ),
            reverse=True,
        )

        sim_threshold = float(self.thresholds.get("synonymClusterSimilarity", 0.72))
        clustered_primaries: List[KeywordObservation] = []
        primary_stems: List[Set[str]] = []

        for candidate in eligible_sorted:
            cand_stems = extract_ru_stems(candidate.phrase)
            merged = False
            for idx, existing in enumerate(clustered_primaries):
                if (
                    candidate.conceptClusterId == existing.conceptClusterId
                    or jaccard_similarity(cand_stems, primary_stems[idx]) >= sim_threshold
                ):
                    existing.mergedVariants.append(candidate.phrase)
                    merged = True
                    break
            if not merged:
                clustered_primaries.append(candidate)
                primary_stems.append(cand_stems)

        limit = int(self.thresholds.get("topObservationLimit", 10))
        return clustered_primaries[:limit], blocked
