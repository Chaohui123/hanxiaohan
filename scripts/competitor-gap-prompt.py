import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser()
parser.add_argument("--report", required=True)
parser.add_argument("--source", required=True)
parser.add_argument("--approval")
args = parser.parse_args()

report_path = Path(args.report).resolve()
source_path = Path(args.source).resolve()
report = json.loads(report_path.read_text(encoding="utf-8"))
source = json.loads(source_path.read_text(encoding="utf-8"))
files = [report_path, source_path]
if args.approval:
    files.append(Path(args.approval).resolve())
fingerprints = [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]
approval = json.loads(files[-1].read_text(encoding="utf-8")) if args.approval else {}
links = [{key: row.get(key) for key in ("offerId", "competitorUrl", "expectedSku", "actualSku", "status", "name", "available", "price", "priceRegular", "rating", "reviewCount", "missingFields", "error")} for row in report.get("links", [])]
payload = {
    "coverage": source.get("competitorCoverage"),
    "report": {key: report.get(key) for key in ("runId", "startedAt", "completedAt", "source", "channel", "attemptTotals", "totals", "previousRunId", "filters")},
    "uploads": report.get("uploads"),
    "rejectedCandidates": approval.get("rejectedCandidates", []),
    "links": links,
}
print(f"""你是Gemini 4 Argon数据质量审查员。只做只读归纳，不扩搜、不补造数据、不操作生产。
请根据输入逐项归纳竞品未抓到或缺失的数据，严格区分：
1. 链接覆盖缺口与抓取失败；2. 价格缺失；3. 评分缺失；4. 评论数缺失；5. 真实0评论；6. 失效404/聚合页；7. 错配候选与相关市场参考；8. 回传失败。
rating=null是未知，不能当作0分；reviewCount=0只有在原始页面明确无评论时才是真实0。价格存在时也要保留price/cardPrice与priceRegular的适用条件，不得把银行优惠价称为无条件成交价。SKU身份一致不等于同规格可比。
不能把已经删除的404/聚合链接或已拒绝的错配候选继续列为当前映射。不得建议调价、恢复本机扫描或自动补链接。
只输出一个JSON对象，格式：
{{"summary":"中文结论","coverage":{{"activeOffers":数字,"coveredOffers":数字,"totalLinks":数字}},"missingByReason":[{{"reason":"分类","offerIds":["货号"],"details":"具体字段与证据"}}],"notMeasuredZero":[{{"field":"字段","offerIds":["货号"],"meaning":"缺失或真实零的区别"}}],"comparabilityLimits":["限制"],"recommendedActions":[{{"priority":1,"action":"最多3项数据修复动作","verification":"可核验标准"}}]}}
输入文件指纹：{json.dumps(fingerprints, ensure_ascii=False)}
输入数据：{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}
""")
