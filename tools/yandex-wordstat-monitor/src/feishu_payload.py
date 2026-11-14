from __future__ import annotations

from typing import Any, Dict, List
from src.models import KeywordObservation, WeeklyObservationReport

WEEKLY_REPORT_CARD_TITLE = "【Ozon选品观察周报】Yandex Wordstat趋势与季节性补证提示"
ALERT_CARD_TITLE = "【告警·Ozon选品观察周报】Wordstat采集异常/配额或数据滞后预警"


def _format_pct(val: float | None) -> str:
    if val is None:
        return "缺失/不适用(不补0)"
    sign = "+" if val > 0 else ""
    return f"{sign}{val * 100:.1f}%"


def _format_cities_line(obs: KeywordObservation) -> str:
    parts: List[str] = []
    for c in obs.referenceCities:
        share_str = f"{c.rawShare * 100:.2f}%" if c.rawShare is not None else "N/A"
        aff_str = f"{c.affinityIndex:.1f}" if c.affinityIndex is not None else "N/A"
        parts.append(f"{c.nameZh}({c.regionId}): 原始share={share_str}, 亲和度={aff_str}")
    return " ｜ ".join(parts)


def build_feishu_weekly_card_payload(report: WeeklyObservationReport) -> tuple[Dict[str, Any], bool]:
    is_alert = report.overallStatus == "failed_alert_only" or (
        len(report.top10Observations) == 0 and len(report.failedRequests) > 0
    )
    header_template = "red" if is_alert else ("orange" if report.overallStatus == "degraded_partial" else "blue")
    title = ALERT_CARD_TITLE if is_alert else WEEKLY_REPORT_CARD_TITLE

    elements: List[Dict[str, Any]] = []

    meta_md = (
        f"**报告周次**：`{report.isoWeek}` ｜ **运行日期**：`{report.runDate}` ｜ **状态**：`{report.overallStatus}`\n"
        f"**Wordstat实际数据截止 (`sourceAsOf`)**：`{report.globalSourceAsOfMin or 'N/A'} ~ {report.globalSourceAsOfMax or 'N/A'}`\n"
        f"**当日请求预算使用**：`{report.budgetUsedToday} / {report.budgetLimitDaily}` ｜ "
        f"**Seller搜索词批次口径**：原生 `{report.sellerValidationContext.nativeWindowDays}` 天 "
        f"(`{report.sellerValidationContext.nativeBatchPages}`页/`{report.sellerValidationContext.nativeBatchRows}`条)，"
        f"自建累计 `{report.sellerValidationContext.selfBuiltProgressLabel}`（严禁伪装完整28天）"
    )
    elements.append({"tag": "div", "text": {"tag": "lark_md", "content": meta_md}})
    elements.append({"tag": "hr"})

    if is_alert:
        err_lines = [
            f"- `{d.endpoint}` | `{d.phrase}` | `{d.errorType}`: {d.message}"
            for d in report.failedRequests[:8]
        ] or ["- 未获取到任何有效周序列或全部种子词处于超期冻结状态，请核查配额、IAM最小权限与上游状态。"]
        alert_body = (
            "**异常说明（上一份已验证成功报告已保留，未被覆盖）**：\n"
            + "\n".join(err_lines)
        )
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": alert_body}})
    else:
        for rank, obs in enumerate(report.top10Observations, start=1):
            score_str = (
                f"{obs.score.observationPriorityScore:.1f}"
                if obs.score.observationPriorityScore is not None
                else f"不评分({obs.score.scoreStatus})"
            )
            vol_str = str(obs.effectiveWeeklyVolume) if obs.effectiveWeeklyVolume is not None else "缺失(不补0)"
            variants_note = f"（归并同义词: {', '.join(obs.mergedVariants)}）" if obs.mergedVariants else ""
            brand_str = f"\n- **品牌/风险核查**：{obs.brandLegalNote}" if obs.brandLegalNote else ""
            warn_preview = f"\n- **数据与口径提示**：{'；'.join(obs.warnings[:2])}" if obs.warnings else ""

            item_md = (
                f"**#{rank} `{obs.phrase}`** {variants_note}\n"
                f"- **中文辅助草稿**：{obs.zhDraft} *（机翻草稿，严禁直接作商品参数/上线文案）*\n"
                f"- **观察排序分**：`{score_str}` ｜ **数据截止(`sourceAsOf`)**：`{obs.sourceAsOf or 'N/A'}` (`{obs.freshnessStatus}`)\n"
                f"- **有效周搜索量**：`{vol_str}` (`{obs.volumeBandStatus}`) ｜ **相邻周WoW**：`{_format_pct(obs.wowRate)}`\n"
                f"- **城市原始分布 (`REGION_CITIES`)**：{_format_cities_line(obs)}\n"
                f"- **检索核验链接**：[Yandex搜索]({obs.yandexSearchUrl}) ｜ [Ozon前台搜索]({obs.ozonSearchUrl})"
                f"{brand_str}{warn_preview}"
            )
            elements.append({"tag": "div", "text": {"tag": "lark_md", "content": item_md}})

            if obs.seasonality.status == "upcoming_peak_window":
                seas_md = (
                    f"  > **季节性补证提示**：{obs.seasonality.uncertaintyNote}\n"
                    f"  > **允许动作**：{'；'.join(obs.seasonality.allowedPreparationActions)}\n"
                    f"  > **红线禁止**：{'；'.join(obs.seasonality.prohibitedActions)}"
                )
                elements.append({"tag": "div", "text": {"tag": "lark_md", "content": seas_md}})
            elements.append({"tag": "hr"})

    disclaimer_md = (
        "**合规与经营边界声明**：\n"
        "1. 本卡片分数仅作人工选品观察排队参考，非上架授权；宽词严禁直接定SKU，须完成 Seller 真实查询、竞品、供货、变体参数、真实单元经济、合规、8图双视频及独立人工复核。\n"
        "2. 城市 `share` 为 Wordstat 原始字段，未篡改重命名为所谓核心城市占比；季节提示严禁作为提前备货指令（无货源模式按现行SOP出单拿样）。\n"
        "3. 系统严格只读分析，不抓 Seller 网页、不创建/改价/改库存/开广告，`PROMO_AUTO_DECISION=false` 保持不变。"
    )
    elements.append({"tag": "div", "text": {"tag": "lark_md", "content": disclaimer_md}})

    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": header_template,
            "title": {"tag": "plain_text", "content": title},
        },
        "elements": elements,
    }
    return card, is_alert
