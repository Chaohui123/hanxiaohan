import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from weekly_report_validation import validate_competitor_report, validate_source

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--competitor-report")
parser.add_argument("--competitor-last-run")
parser.add_argument("--direct-report")
args = parser.parse_args()
source_path = Path(args.source).resolve()
source = json.loads(source_path.read_text(encoding="utf-8"))
source_validation = validate_source(source)
inputs = [{"path": str(source_path), "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest()}]
competitor = None
competitor_validation = None
last_run = None
last_run_error = None
if args.competitor_report:
    competitor_path = Path(args.competitor_report).resolve()
    competitor = json.loads(competitor_path.read_text(encoding="utf-8"))
    inputs.append({"path": str(competitor_path), "sha256": hashlib.sha256(competitor_path.read_bytes()).hexdigest()})
    last_run_path = Path(args.competitor_last_run).resolve() if args.competitor_last_run else competitor_path.parent / "last-run.json"
    try:
        last_run = json.loads(last_run_path.read_text(encoding="utf-8"))
        inputs.append({"path": str(last_run_path), "sha256": hashlib.sha256(last_run_path.read_bytes()).hexdigest()})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as error:
        last_run_error = str(error)
    competitor_validation = validate_competitor_report(competitor, last_run=last_run)
    if last_run_error:
        competitor_validation["lastRunReadError"] = last_run_error
        competitor_validation["staleReasons"].append("latest run-state is unreadable")
        competitor_validation["usable"] = False
default_direct_path = ROOT / "temp" / "direct-reports" / "latest.json"
direct_path = Path(args.direct_report).resolve() if args.direct_report else default_direct_path
direct_report = None
direct_meta = None
last_error = None
if direct_path == default_direct_path:
    error_path = direct_path.parent / "last-error.json"
    if error_path.exists():
        last_error = json.loads(error_path.read_text(encoding="utf-8"))
        inputs.append({"path": str(error_path), "sha256": hashlib.sha256(error_path.read_bytes()).hexdigest()})
if direct_path.exists():
    direct_report = json.loads(direct_path.read_text(encoding="utf-8"))
    inputs.append({"path": str(direct_path), "sha256": hashlib.sha256(direct_path.read_bytes()).hexdigest()})
    collected_at = datetime.fromisoformat(direct_report["collectedAt"].replace("Z", "+00:00"))
    age_hours = (datetime.now(timezone.utc) - collected_at).total_seconds() / 3600
    if last_error is not None:
        error_time = datetime.fromisoformat(last_error["collectedAt"].replace("Z", "+00:00"))
        if error_time < collected_at:
            last_error = None
    direct_meta = {"ageHours": round(age_hours, 2), "stale": age_hours > 36 or age_hours < 0, "lastError": last_error}

prompt = f"""你是跨境电商高级运营评审。只做只读分析，不探索仓库，不操作任何生产数据。
请基于下列带时间戳的真实数据，给出下周最多3项优先行动，按影响力/风险排序，并给出每项的可核验完成标准。区分事实、推断与未知，禁止补造销量、转化、利润、竞品价格或模型调用结果。

硬约束：
- 店铺经营快照期间为 {source['operationsPeriod']['dateFrom']} 至 {source['operationsPeriod']['dateTo']}，下单金额为{source['operationsTotals'].get('orderedRevenueRub')}₽、下单件数为{source['operationsTotals'].get('orderedUnits')}；orderedRevenueRub不是实收或净利润。采集校验为 {json.dumps(source_validation, ensure_ascii=False)}；stale或不可用时只能作历史参考，不得称为店铺当前近7天。
- 评价活动负余额暂停，不充值、不恢复；不恢复已停止的选品或不合格素材制作。
- Ozon生产商品、价格、库存只能由Kimi主Agent操作。你的建议不能直接执行。
- 自动调价当前为false，不得因竞品数据缺口建议降价、涨价或开启自动调价。
- 竞品已在服务器远程采集，旧本机扫描不得恢复。只有direct_comparable且priceType=regular的有效快照才能进入直接价格比较；priceRegular是常规价，price/cardPrice是展示优惠候选，不能冒充无条件成交价。legacy_unknown、市场参考、待复核与缺常规价记录均不可用于直接调价判断；缺失评分/评论不是0，lastCapturedAt不是实时价格。pendingReconciliation与reconciliationErrors必须单列，未对账不得假称全批健康；competitor validation不可用时不得当成当前可比数据。
- Direct campaign 715426752仅保温罩，俄罗斯，CPA 1.2美元、周预算12美元、预算自动上浮关闭。启动须由Kimi在利润、预算、广告法资料、Ozon集成核验后执行；你不得启动或扩大投放。
- ONZO Ads Manager仅提供只读Reports证据，当前marketplace设置不通过API修改。Direct站外数据不得与Ozon原生广告混用；当前UTC日为部分数据且单列，last7Days/previous7Days仅含完整日，0转化时实际CPA不可计算。
- 不重复跑模型、不扩搜货源、不把搜索次数当成果。每项计划必须可在一周内验收。

输出四节：核心经营判读；竞品数据缺口及处置；下周最多3项行动（负责人、完成标准）；明确停止/不做事项。
数据文件指纹：{json.dumps(inputs, ensure_ascii=False)}
店铺真实数据：{json.dumps(source, ensure_ascii=False, separators=(',', ':'))}
"""
if competitor is not None:
    prompt += "远程竞品采集报告：" + json.dumps({"report": competitor, "validation": competitor_validation, "lastRun": last_run}, ensure_ascii=False, separators=(",", ":")) + "\n"
else:
    prompt += "远程竞品采集报告尚未取得；不得将链接清单或历史lastCapturedAt当成新抓取成功。\n"
if direct_report is not None:
    prompt += "ONZO Ads Manager只读Direct报表：" + json.dumps({"report": direct_report, "freshness": direct_meta}, ensure_ascii=False, separators=(",", ":")) + "\n"
elif last_error is not None:
    prompt += "ONZO Ads Manager最近采集失败：" + json.dumps(last_error, ensure_ascii=False, separators=(",", ":")) + "\n"
else:
    prompt += "ONZO Ads Manager报表尚未取得；Direct指标保持未知，不得填0或沿用旧数据冒充本批。\n"
print(prompt)
