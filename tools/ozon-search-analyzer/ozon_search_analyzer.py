from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import numbers
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping, Sequence
from urllib.parse import quote_plus

import numpy as np
import pandas as pd
import yaml
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

TOOL_VERSION = "1.0.0"
PROFILE = "days_7_calibrated"
MIN_ACTIVE_WEIGHT = 0.65
FIXED_WEIGHTS = MappingProxyType(
    {"heat": 0.30, "no_int": 0.35, "ca": 0.25, "price": 0.10}
)
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "config.yaml"
DEFAULT_BLACKLIST = BASE_DIR / "blacklist.txt"
DEFAULT_GOVERNANCE_CONFIG = BASE_DIR.parent / "yandex-wordstat-monitor" / "config.yaml"
DEFAULT_TRANSLATION_OVERRIDES = BASE_DIR / "review-overrides.yaml"
OUTPUT_EXCEL = "ozon_selection_report.xlsx"
OUTPUT_BRIEF = "ozon_selection_brief.md"
OUTPUT_MANIFEST = "run_manifest.json"

REQUIRED_FIELDS = ("query", "count")
RATIO_FIELDS = (
    "ca",
    "searchUsersToOrdUsers",
    "usersWithoutInterectionShare",
    "zrShare",
)
PERCENT_FIELDS = RATIO_FIELDS + ("dynamic7", "dynamic28")
NUMERIC_FIELDS = (
    "count",
    "uniqQueriesWCa",
    "ca",
    "ord",
    "searchUsersToOrdUsers",
    "gmv",
    "avgCaRub",
    "itemsViews",
    "uniqSellers",
    "usersWithoutInterectionCount",
    "usersWithoutInterectionShare",
    "zrCount",
    "zrShare",
    "dynamic7",
    "dynamic28",
)
NON_NEGATIVE_FIELDS = tuple(field for field in NUMERIC_FIELDS if field not in {"dynamic7", "dynamic28"})
ALL_FIELDS = ("query",) + NUMERIC_FIELDS
NULL_TOKENS = {"", "null", "none", "nan", "n/a", "na"}
STOPWORDS = {
    "а", "в", "во", "для", "до", "и", "из", "к", "ко", "на", "над", "не",
    "о", "об", "от", "по", "под", "при", "с", "со", "у", "за",
}
AMBIGUOUS_BARE_NOISE_TOKENS = frozenset({"фото", "видео", "ремонт"})
MANUAL_REVIEW_TOP30_BLOCKERS = frozenset({"AMBIGUOUS_IDENTITY", "BRAND_REVIEW_REQUIRED"})
QUADRANT_PRIORITY = ("蓝海缺口", "高转化刚需", "高客单垂类")
REGULAR_QUADRANT = "常规观察池"
PENDING_ECONOMICS_INPUTS = (
    "1688实价待核；国内运费待核；包装待核；实测克重与尺寸待核；实际FBS/rFBS仓线待核；"
    "类目佣金待核；退货待核；支付待核；实际CPS待核"
)
MANDATORY_PENDING_ACTIONS = (
    "前台真实需求与竞争待核；准确商品身份/变体/关键参数待核；季节窗口与跨境妥投周期待核；合规/禁限运/退货风险待核；"
    + PENDING_ECONOMICS_INPUTS
    + "；持续净利率>=10%才可测、>=15%优先；完整8图+双视频与独立复核未完成前不得上架"
)
GOVERNANCE_BOUNDARIES = [
    "纯离线只读分析；所有象限与Top30均为待核假设，非立项、采购、拿样、调价、广告、付费制作或上架授权",
    "count是Ozon Seller days_7搜索查询热度，不是月搜索量、绝对搜索次数或本店SKU漏斗，不跨词累加",
    "avgCaRub是平均价格RUB，不是CPC；不反推搜索人数、无交互人数或其他未返回分子分母",
    "仅适用国内跨境FBS/rFBS；不使用默认25%毛利、不虚构FBO、不以占位费率计算成本上限",
    "Wordstat只读取既有真实回执，不发网络请求；MISSING/UNCERTAIN不补0、不重发、不进入主评分",
    "非购买噪音适配：裸фото/видео/ремонт存在商品语义歧义，保留中央配置但不自动隔离；其他单词仅匹配字面整词，多词词组可用词干组合",
    "NUMERIC_FULL_4D_ONLY仅表示四个评分维度的数值完整，不代表商品身份、合规、供货、经济或商业PASS",
]

DEFAULT_THRESHOLDS: dict[str, Any] = {
    "count_days7_valid_floor": 3774.0,
    "count_days7_niche_min": 5000.0,
    "count_days7_sweet_spot_max": 35000.0,
    "count_days7_broad_head_warn": 50000.0,
    "no_interaction_gap_min_pct": 45.0,
    "no_interaction_dead_bounce_max_pct": 85.0,
    "ca_high_demand_min_pct": 35.0,
    "ca_viable_floor_pct": 15.0,
    "top30_min_search_to_ord_pct": 2.0,
    "ca_high_ticket_min_pct": 18.0,
    "ord_conv_rigid_min_pct": 10.0,
    "ord_commercial_proof_min_buyers": 50.0,
    "ord_rigid_demand_min_buyers": 300.0,
    "avg_price_fbs_viable_floor_rub": 1500.0,
    "avg_price_high_conversion_floor_rub": 1200.0,
    "avg_price_high_ticket_min_rub": 2500.0,
    "avg_price_cross_border_safe_max_rub": 25000.0,
    "avg_price_extreme_outlier_rub": 100000.0,
    "uniq_sellers_low_density_max": 20.0,
    "zr_share_signal_min_pct": 2.0,
    "robust_scale_quantiles": [0.05, 0.95],
}

SCHEMA_ALIASES: dict[str, tuple[str, ...]] = {
    "query": ("query", "Поисковый запрос", "Запрос", "搜索查询", "搜索词", "关键词"),
    "count": ("count", "Популярность запроса", "Популярность", "搜索查询热度", "搜索热度", "查询热度"),
    "uniqQueriesWCa": (
        "uniqQueriesWCa", "Уникальные запросы с добавлением в корзину",
        "Уникальные запросы с добавлением в корзину, шт.", "加购独立查询数", "带加购的唯一查询",
    ),
    "ca": ("ca", "Конверсия в корзину, %", "Конверсия в корзину", "加购转化率", "加购率%"),
    "ord": ("ord", "Покупатели с заказом", "Заказы (покупатели)", "下单买家数", "下单独立买家"),
    "searchUsersToOrdUsers": (
        "searchUsersToOrdUsers", "Конверсия из поиска в заказ, %", "搜索转下单率", "搜索到下单转化率",
    ),
    "gmv": ("gmv", "Продажи, ₽", "Сумма заказов, ₽", "销售额", "GMV"),
    "avgCaRub": ("avgCaRub", "Средняя цена, ₽", "Средняя цена в корзине, ₽", "平均价格", "平均加购价RUB"),
    "itemsViews": ("itemsViews", "Количество показанных товаров", "Показанные товары", "展示商品数量", "展示商品数"),
    "uniqSellers": ("uniqSellers", "Уникальные продавцы", "Продавцы", "唯一卖家数", "卖家数"),
    "usersWithoutInterectionCount": (
        "usersWithoutInterectionCount", "usersWithoutInteractionCount",
        "Пользователи без взаимодействий", "Количество пользователей без взаимодействий",
        "无交互用户数", "无操作用户数",
    ),
    "usersWithoutInterectionShare": (
        "usersWithoutInterectionShare", "usersWithoutInteractionShare",
        "Доля пользователей без взаимодействий, %", "Без взаимодействий, %",
        "无交互用户份额", "无操作份额",
    ),
    "zrCount": (
        "zrCount", "Запросы с нулевой выдачей", "Количество нулевых результатов",
        "零结果数", "零结果查询数",
    ),
    "zrShare": ("zrShare", "Доля нулевых результатов, %", "Нулевая выдача, %", "零结果份额", "无结果占比"),
    "dynamic7": ("dynamic7", "Динамика 7 дней", "Динамика, 7 дней", "7天动态", "近7天变化"),
    "dynamic28": ("dynamic28", "Динамика 28 дней", "Динамика, 28 дней", "28天动态", "近28天变化"),
}
ALIAS_LOOKUP = {
    unicodedata.normalize("NFKC", alias).strip().lower(): field
    for field, aliases in SCHEMA_ALIASES.items()
    for alias in aliases
}


class AnalyzerInputError(ValueError):
    pass


@dataclass(frozen=True)
class RuntimeConfig:
    thresholds: dict[str, Any]
    blacklist: tuple[str, ...]
    governance_rules: dict[str, tuple[dict[str, str], ...]]
    config_path: str | None
    blacklist_path: str | None
    governance_config_path: str | None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_header(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value)).strip()).lower()


def normalize_query(value: Any) -> str:
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    return re.sub(r"\s+", " ", text.strip()).lower()


def fold_yo(value: str) -> str:
    return value.replace("ё", "е")


def query_tokens(value: Any, fold: bool = True) -> list[str]:
    text = normalize_query(value)
    if fold:
        text = fold_yo(text)
    return re.findall(r"[0-9a-zа-я]+", text)


def json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        value = float(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if value is not None and not isinstance(value, (str, int, float, bool)):
        return str(value)
    return value


def read_yaml(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    if not path.is_file():
        raise AnalyzerInputError(f"YAML配置不存在: {path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise AnalyzerInputError(f"YAML配置读取失败: {path}: {exc}") from exc
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise AnalyzerInputError(f"YAML顶层必须是对象: {path}")
    return data


def parse_blacklist(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return ()
    if not path.is_file():
        raise AnalyzerInputError(f"黑名单不存在: {path}")
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError) as exc:
        raise AnalyzerInputError(f"黑名单读取失败: {path}: {exc}") from exc
    return tuple(line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#"))


def parse_rule_entries(value: Any, category: str, source: str) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise AnalyzerInputError(f"governanceRules.{category}必须是列表")
    rules: list[dict[str, str]] = []
    for index, item in enumerate(value):
        if isinstance(item, str):
            pattern, reason = item, "命中治理规则"
        elif isinstance(item, dict) and isinstance(item.get("pattern"), str):
            pattern = item["pattern"]
            reason = str(item.get("reason") or "命中治理规则")
        else:
            raise AnalyzerInputError(f"治理规则{category}[{index}]缺少字符串pattern")
        if pattern.strip():
            rules.append(
                {
                    "pattern": pattern.strip(),
                    "reason": reason,
                    "category": category,
                    "rule_id": f"{source}:{category}[{index}]",
                }
            )
    return rules


def contains_weight_override(value: Any) -> bool:
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = str(key).replace("_", "").lower()
            if normalized in {
                "weights", "fixedweights", "scoreweights", "countheatweight",
                "userswithoutinteractionshareweight", "cartconversioncaweight", "avgcarubpriceweight",
            }:
                return True
            if contains_weight_override(item):
                return True
    elif isinstance(value, (list, tuple)):
        return any(contains_weight_override(item) for item in value)
    return False


def load_runtime_config(
    config_path: str | Path | None = DEFAULT_CONFIG,
    blacklist_path: str | Path | None = DEFAULT_BLACKLIST,
    governance_config_path: str | Path | None = DEFAULT_GOVERNANCE_CONFIG,
) -> RuntimeConfig:
    local_path = Path(config_path).resolve() if config_path else None
    blacklist = Path(blacklist_path).resolve() if blacklist_path else None
    central_path = Path(governance_config_path).resolve() if governance_config_path else None
    local = read_yaml(local_path)
    central = read_yaml(central_path)
    profile = local.get("profile", PROFILE)
    if profile != PROFILE:
        raise AnalyzerInputError(f"仅支持{PROFILE}，实际配置: {profile}")
    if contains_weight_override(local):
        raise AnalyzerInputError("评分权重固定为0.30/0.35/0.25/0.10，禁止任何配置覆盖")
    configured_thresholds = local.get("thresholds", {})
    if not isinstance(configured_thresholds, dict):
        raise AnalyzerInputError("config.thresholds必须是对象")
    unknown = sorted(set(configured_thresholds) - set(DEFAULT_THRESHOLDS))
    if unknown:
        raise AnalyzerInputError(f"未知阈值参数: {', '.join(unknown)}")
    thresholds = dict(DEFAULT_THRESHOLDS)
    thresholds.update(configured_thresholds)
    for key, value in thresholds.items():
        if key == "robust_scale_quantiles":
            continue
        if isinstance(value, bool) or not isinstance(value, numbers.Real) or not math.isfinite(float(value)):
            raise AnalyzerInputError(f"阈值{key}必须是有限数值")
        thresholds[key] = float(value)
    quantiles = thresholds["robust_scale_quantiles"]
    if (
        not isinstance(quantiles, (list, tuple))
        or len(quantiles) != 2
        or any(isinstance(v, bool) or not isinstance(v, numbers.Real) for v in quantiles)
    ):
        raise AnalyzerInputError("robust_scale_quantiles必须是两个数值")
    q_low, q_high = float(quantiles[0]), float(quantiles[1])
    if not 0 <= q_low < q_high <= 1:
        raise AnalyzerInputError("robust_scale_quantiles必须满足0<=P低<P高<=1")
    thresholds["robust_scale_quantiles"] = [q_low, q_high]
    thresholds["no_interaction_dead_bounce_max_pct"] = min(
        85.0, thresholds["no_interaction_dead_bounce_max_pct"]
    )
    merged: dict[str, list[dict[str, str]]] = {
        "terminatedDirections": [],
        "existingPortfolioExclusions": [],
        "nonPurchaseNoiseTokens": [],
        "brandWatchTokens": [],
    }
    for source_name, document in (("central", central), ("local", local)):
        rules = document.get("governanceRules", {})
        if not isinstance(rules, dict):
            raise AnalyzerInputError(f"governanceRules必须是对象: {source_name}")
        for category in merged:
            merged[category].extend(parse_rule_entries(rules.get(category), category, source_name))
    return RuntimeConfig(
        thresholds=thresholds,
        blacklist=parse_blacklist(blacklist),
        governance_rules={key: tuple(value) for key, value in merged.items()},
        config_path=str(local_path) if local_path else None,
        blacklist_path=str(blacklist) if blacklist else None,
        governance_config_path=str(central_path) if central_path else None,
    )


def read_csv_raw(path: Path) -> tuple[pd.DataFrame, None]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            sample = handle.read(8192)
            handle.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
            except csv.Error:
                dialect = csv.excel
            reader = csv.reader(handle, dialect)
            try:
                headers = next(reader)
            except StopIteration as exc:
                raise AnalyzerInputError("CSV完全为空，无合法表头") from exc
            if not headers or not any(str(item).strip() for item in headers):
                raise AnalyzerInputError("CSV完全无表头")
            rows: list[list[Any]] = []
            for line_number, row in enumerate(reader, start=2):
                if not row:
                    continue
                if len(row) != len(headers):
                    raise AnalyzerInputError(
                        f"CSV第{line_number}行有{len(row)}列，表头有{len(headers)}列"
                    )
                rows.append(row)
    except (OSError, UnicodeError, csv.Error) as exc:
        raise AnalyzerInputError(f"CSV读取失败: {exc}") from exc
    return pd.DataFrame(rows, columns=headers), None


def read_xlsx_raw(path: Path) -> tuple[pd.DataFrame, Any]:
    try:
        workbook = load_workbook(path, read_only=True, data_only=True, keep_links=False)
        worksheet = workbook.active
        row_cells = list(worksheet.iter_rows())
    except Exception as exc:
        raise AnalyzerInputError(f"XLSX读取失败: {exc}") from exc
    finally:
        if "workbook" in locals():
            workbook.close()
    if not row_cells:
        raise AnalyzerInputError("XLSX完全为空，无合法表头")
    header_cells = row_cells[0]
    headers = [cell.value for cell in header_cells]
    if not headers or not any(value is not None and str(value).strip() for value in headers):
        raise AnalyzerInputError("XLSX完全无表头")
    rows = [[cell.value for cell in row] for row in row_cells[1:]]
    return pd.DataFrame(rows, columns=headers), row_cells


def map_schema(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any], dict[str, int]]:
    matches: dict[str, list[int]] = {field: [] for field in ALL_FIELDS}
    for index, header in enumerate(raw.columns):
        field = ALIAS_LOOKUP.get(normalize_header(header))
        if field:
            matches[field].append(index)
    conflicts = {field: indices for field, indices in matches.items() if len(indices) > 1}
    if conflicts:
        details = []
        for field, indices in conflicts.items():
            names = [str(raw.columns[index]) for index in indices]
            details.append(f"{field}: {names}")
        raise AnalyzerInputError("多列映射冲突: " + "; ".join(details))
    missing = [field for field in REQUIRED_FIELDS if not matches[field]]
    if missing:
        supported = {
            field: list(SCHEMA_ALIASES[field]) for field in missing
        }
        raise AnalyzerInputError(
            f"缺少必需列或无合法表头: {', '.join(missing)}；支持别名: {json.dumps(supported, ensure_ascii=False)}"
        )
    source_columns = {field: indices[0] for field, indices in matches.items() if indices}
    mapped = pd.DataFrame(index=raw.index)
    for field in ALL_FIELDS:
        if field in source_columns:
            mapped[field] = raw.iloc[:, source_columns[field]]
        else:
            mapped[field] = np.nan
    mapped.insert(0, "original_row_id", np.arange(2, len(raw) + 2, dtype=int))
    audit = {
        "inputColumns": [None if value is None else str(value) for value in raw.columns],
        "columnMapping": {
            field: str(raw.columns[index]) for field, index in source_columns.items()
        },
        "unmappedColumns": [
            str(raw.columns[index])
            for index in range(len(raw.columns))
            if index not in source_columns.values()
        ],
        "percentageConversions": [],
    }
    return mapped, audit, source_columns


def apply_xlsx_percent_formats(
    mapped: pd.DataFrame,
    row_cells: Any,
    source_columns: dict[str, int],
    audit: dict[str, Any],
) -> None:
    if row_cells is None:
        return
    for field, column_index in source_columns.items():
        if field not in PERCENT_FIELDS:
            continue
        for row_index, cells in enumerate(row_cells[1:]):
            if column_index >= len(cells):
                continue
            cell = cells[column_index]
            value = cell.value
            if (
                isinstance(value, numbers.Real)
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                and 0 <= float(value) <= 1
                and "%" in str(cell.number_format)
            ):
                converted = float(value) * 100
                mapped.at[row_index, field] = converted
                audit["percentageConversions"].append(
                    {
                        "original_row_id": row_index + 2,
                        "field": field,
                        "rawValue": float(value),
                        "convertedPercent": converted,
                        "numberFormat": str(cell.number_format),
                    }
                )


def read_and_map_seller_queries(input_path: str | Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    path = Path(input_path)
    if not path.is_file():
        raise AnalyzerInputError(f"输入文件不存在: {path}")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        raw, row_cells = read_csv_raw(path)
    elif suffix == ".xlsx":
        raw, row_cells = read_xlsx_raw(path)
    else:
        raise AnalyzerInputError("仅支持.xlsx或.csv输入")
    mapped, audit, source_columns = map_schema(raw)
    apply_xlsx_percent_formats(mapped, row_cells, source_columns, audit)
    return mapped, audit


def is_null_numeric(value: Any) -> bool:
    if value is None or value is pd.NA:
        return True
    if isinstance(value, str):
        return value.strip().lower() in NULL_TOKENS
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def parse_numeric(value: Any) -> tuple[float, str | None]:
    if is_null_numeric(value):
        return np.nan, None
    if isinstance(value, bool):
        return np.nan, "布尔值不是数值"
    try:
        number = float(str(value).strip()) if isinstance(value, str) else float(value)
    except (TypeError, ValueError, OverflowError):
        return np.nan, f"非数值: {value!r}"
    if not math.isfinite(number):
        return np.nan, f"非有限数值: {value!r}"
    return number, None


def raw_snapshot(row: pd.Series) -> str:
    values = {field: json_safe(row.get(field)) for field in ALL_FIELDS}
    return json.dumps(values, ensure_ascii=False, allow_nan=False)


def clean_validate_and_quarantine(
    raw_df: pd.DataFrame, config: RuntimeConfig | None = None
) -> tuple[pd.DataFrame, pd.DataFrame]:
    valid_rows: list[pd.Series] = []
    quarantine_rows: list[dict[str, Any]] = []
    for _, source_row in raw_df.iterrows():
        row = source_row.copy()
        snapshot = raw_snapshot(source_row)
        reasons: list[str] = []
        details: list[str] = []
        raw_query = source_row.get("query")
        query_text = "" if is_null_numeric(raw_query) else str(raw_query).strip()
        if not query_text:
            reasons.append("EMPTY_QUERY")
            details.append("搜索词为空")
            row["query"] = np.nan
        else:
            row["query"] = query_text
        for field in NUMERIC_FIELDS:
            number, error = parse_numeric(source_row.get(field))
            row[field] = number
            if error:
                reasons.append("NON_NUMERIC_METRIC")
                details.append(f"{field}: {error}")
        count = row["count"]
        count_was_non_numeric = any(detail.startswith("count:") for detail in details)
        if pd.isna(count) and not count_was_non_numeric:
            reasons.append("MISSING_COUNT")
            details.append("count必需单元格为空，必须为合法正值")
        elif not pd.isna(count) and count <= 0:
            reasons.append("NON_POSITIVE_COUNT")
            details.append("count必须为正值")
        for field in NON_NEGATIVE_FIELDS:
            value = row[field]
            if not pd.isna(value) and value < 0:
                reasons.append("NEGATIVE_METRIC")
                details.append(f"{field}={value}为负值")
        for field in RATIO_FIELDS:
            value = row[field]
            if not pd.isna(value) and not 0 <= value <= 100.0001:
                reasons.append("RATIO_OUT_OF_BOUNDS")
                details.append(f"{field}={value}超出0..100")
        row["raw_query"] = raw_query
        row["raw_row_json_snapshot"] = snapshot
        if reasons:
            quarantine_rows.append(
                {
                    **row.to_dict(),
                    "isolation_type": "|".join(dict.fromkeys(reasons)),
                    "isolation_detail": "；".join(details),
                    "kept_master_row_id": np.nan,
                }
            )
        else:
            valid_rows.append(row)
    columns = list(raw_df.columns) + ["raw_query", "raw_row_json_snapshot"]
    if valid_rows:
        valid = pd.DataFrame(valid_rows).reset_index(drop=True)
    else:
        valid = pd.DataFrame(columns=columns)
    if quarantine_rows:
        quarantine = pd.DataFrame(quarantine_rows)
    else:
        quarantine = pd.DataFrame(
            columns=columns + ["isolation_type", "isolation_detail", "kept_master_row_id"]
        )
    for frame in (valid, quarantine):
        for field in NUMERIC_FIELDS:
            if field in frame:
                frame[field] = pd.to_numeric(frame[field], errors="coerce").astype(float)
    return valid, quarantine


def token_cluster_key(query_norm: str) -> str:
    return " ".join(sorted(fold_yo(token) for token in query_tokens(query_norm)))


def token_cluster_id(query_norm: str) -> str:
    key = token_cluster_key(query_norm)
    return "cluster_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def deduplicate_and_cluster_queries(
    valid_df: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if valid_df.empty:
        dedup = valid_df.copy()
        dedup["query_norm"] = pd.Series(dtype=str)
        dedup["token_cluster_id"] = pd.Series(dtype=str)
        dedup["token_cluster_key"] = pd.Series(dtype=str)
        return dedup, pd.DataFrame(
            columns=list(valid_df.columns)
            + ["query_norm", "isolation_type", "isolation_detail", "kept_master_row_id"]
        )
    work = valid_df.copy()
    work["query_norm"] = work["query"].map(normalize_query)
    work["_completeness"] = work[list(NUMERIC_FIELDS)].notna().sum(axis=1)
    work = work.sort_values(
        ["query_norm", "_completeness", "original_row_id"],
        ascending=[True, False, True],
        kind="mergesort",
    )
    master_ids = work.groupby("query_norm", sort=False)["original_row_id"].first().to_dict()
    duplicate_mask = work.duplicated("query_norm", keep="first")
    duplicates = work.loc[duplicate_mask].copy()
    if not duplicates.empty:
        duplicates["isolation_type"] = "EXACT_DUPLICATE_REMOVED"
        duplicates["isolation_detail"] = "NFKC+trim+空白合并+lower精确重复；指标不累加"
        duplicates["kept_master_row_id"] = duplicates["query_norm"].map(master_ids)
    dedup = work.loc[~duplicate_mask].copy()
    dedup["token_cluster_key"] = dedup["query_norm"].map(token_cluster_key)
    dedup["token_cluster_id"] = dedup["query_norm"].map(token_cluster_id)
    dedup = dedup.sort_values("original_row_id", kind="mergesort").drop(columns="_completeness")
    duplicates = duplicates.drop(columns="_completeness")
    return dedup.reset_index(drop=True), duplicates.reset_index(drop=True)


RUSSIAN_SUFFIXES = tuple(
    sorted(
        {
            "иями", "ями", "ами", "ового", "евого", "ными", "ыми", "ими",
            "ения", "ание", "ение", "ости", "ести", "елью", "иях", "ях",
            "ах", "ого", "его", "ому", "ему", "ыми", "иям", "ям", "ием",
            "ьям", "ью", "ию", "ия", "ие", "ья", "ье", "ов", "ев", "ой",
            "ей", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ым",
            "им", "ых", "их", "ам", "ем", "ом", "ат", "ят", "ут", "ют",
            "ет", "ит", "ешь", "ите", "ала", "яла", "али", "яли", "ать",
            "ять", "ить", "ыть", "а", "я", "о", "е", "ы", "и", "у", "ю",
        },
        key=len,
        reverse=True,
    )
)


def stem_token(token: str) -> str:
    token = fold_yo(token)
    if not re.search(r"[а-я]", token):
        return token
    if token.startswith("женщин") or token.startswith("женск"):
        return "жен"
    if re.fullmatch(r"рем(?:ень|ня|ню|нем|не|ни|ней|ням|нями|нях)", token):
        return "ремен"
    if token.startswith("датчик"):
        return "датчик"
    if len(token) <= 4:
        return token
    for suffix in RUSSIAN_SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 4:
            return token[: -len(suffix)]
    return token


def is_ambiguous_bare_noise(phrase: str) -> bool:
    tokens = query_tokens(phrase)
    return len(tokens) == 1 and tokens[0] in AMBIGUOUS_BARE_NOISE_TOKENS


def literal_phrase_matches(query: Any, phrase: str) -> bool:
    tokens = query_tokens(query)
    pattern = query_tokens(phrase)
    if not pattern or len(tokens) < len(pattern):
        return False
    for start in range(len(tokens) - len(pattern) + 1):
        if tokens[start : start + len(pattern)] == pattern:
            return True
    return False


def stem_phrase_matches(query: Any, phrase: str) -> bool:
    tokens = [token for token in query_tokens(query) if token not in STOPWORDS]
    rule_tokens = [token for token in query_tokens(phrase) if token not in STOPWORDS]
    if not rule_tokens:
        return False
    stems = [stem_token(token) for token in tokens]
    for raw_rule_token in rule_tokens:
        rule_stem = stem_token(raw_rule_token)
        matched = False
        for raw_token, token_stem in zip(tokens, stems):
            if raw_token == raw_rule_token or token_stem == rule_stem:
                matched = True
                break
            if len(rule_stem) >= 4 and raw_token.startswith(rule_stem):
                matched = True
                break
            if len(token_stem) >= 4 and rule_stem.startswith(token_stem):
                matched = True
                break
        if not matched:
            return False
    return True


def collect_guard_matches(query: Any, config: RuntimeConfig) -> list[dict[str, str]]:
    matches: list[dict[str, str]] = []
    for index, phrase in enumerate(config.blacklist):
        if literal_phrase_matches(query, phrase):
            matches.append(
                {
                    "category": "BRAND_IP_BLACKLIST",
                    "rule_id": f"blacklist.txt[{index}]",
                    "pattern": phrase,
                    "reason": "命中本地品牌/IP/平台黑名单",
                }
            )
    category_names = {
        "terminatedDirections": "SHOP_TERMINATED_DIRECTION",
        "existingPortfolioExclusions": "SHOP_EXISTING_SKU",
        "nonPurchaseNoiseTokens": "NON_PURCHASE_NOISE",
        "brandWatchTokens": "BRAND_IP_BLACKLIST",
    }
    for category, output_category in category_names.items():
        for rule in config.governance_rules.get(category, ()):
            phrase = rule["pattern"]
            if category == "nonPurchaseNoiseTokens" and is_ambiguous_bare_noise(phrase):
                continue
            if category == "brandWatchTokens":
                matched = literal_phrase_matches(query, phrase)
            elif category == "nonPurchaseNoiseTokens":
                matched = (
                    stem_phrase_matches(query, phrase)
                    if len(query_tokens(phrase)) > 1
                    else literal_phrase_matches(query, phrase)
                )
            else:
                matched = stem_phrase_matches(query, phrase)
            if matched:
                matches.append({**rule, "category": output_category})
    return matches


def apply_blacklist_and_shop_direction_guards(
    dedup_df: pd.DataFrame, config: RuntimeConfig
) -> tuple[pd.DataFrame, pd.DataFrame]:
    eligible_indices: list[int] = []
    filtered_rows: list[dict[str, Any]] = []
    category_priority = {
        "SHOP_TERMINATED_DIRECTION": 0,
        "SHOP_EXISTING_SKU": 1,
        "BRAND_IP_BLACKLIST": 2,
        "NON_PURCHASE_NOISE": 3,
    }
    for index, row in dedup_df.iterrows():
        matches = collect_guard_matches(row["query"], config)
        if not matches:
            eligible_indices.append(index)
            continue
        matches.sort(key=lambda item: (category_priority[item["category"]], item["rule_id"]))
        primary = matches[0]
        filtered_rows.append(
            {
                **row.to_dict(),
                "filter_category": primary["category"],
                "matched_rule_id": "|".join(dict.fromkeys(item["rule_id"] for item in matches)),
                "matched_keyword_or_pattern": "|".join(
                    dict.fromkeys(item["pattern"] for item in matches)
                ),
                "filter_explanation": "|".join(
                    dict.fromkeys(item["reason"] for item in matches)
                ),
                "all_filter_categories": "|".join(
                    dict.fromkeys(item["category"] for item in matches)
                ),
                "governance_audit_json": json.dumps(matches, ensure_ascii=False),
            }
        )
    eligible = dedup_df.loc[eligible_indices].copy().reset_index(drop=True)
    filter_columns = list(dedup_df.columns) + [
        "filter_category", "matched_rule_id", "matched_keyword_or_pattern",
        "filter_explanation", "all_filter_categories", "governance_audit_json",
    ]
    filtered = pd.DataFrame(filtered_rows) if filtered_rows else pd.DataFrame(columns=filter_columns)
    if not filtered.empty:
        filtered = filtered.sort_values(
            ["filter_category", "count", "original_row_id"],
            ascending=[True, False, True],
            kind="mergesort",
        ).reset_index(drop=True)
    return eligible, filtered


def scale_robust(
    series: pd.Series,
    quantiles: Sequence[float],
    log_transform: bool = False,
    positive_only: bool = False,
    upper_anchor_cap: float | None = None,
) -> tuple[pd.Series, dict[str, Any]]:
    numeric = pd.to_numeric(series, errors="coerce").astype(float)
    valid_mask = numeric.notna() & np.isfinite(numeric)
    if positive_only:
        valid_mask &= numeric > 0
    scores = pd.Series(np.nan, index=series.index, dtype=float)
    values = numeric.loc[valid_mask]
    metadata: dict[str, Any] = {
        "present": int(valid_mask.sum()),
        "missingOrIneligible": int((~valid_mask).sum()),
        "log1p": log_transform,
        "lowerAnchor": None,
        "upperAnchor": None,
        "lowerAnchorRaw": None,
        "upperAnchorRaw": None,
        "collapsedTo": None,
    }
    if values.empty:
        return scores, metadata
    transformed = np.log1p(values) if log_transform else values
    lower = float(transformed.quantile(quantiles[0]))
    upper = float(transformed.quantile(quantiles[1]))
    if upper_anchor_cap is not None:
        upper = min(upper, upper_anchor_cap)
    metadata["lowerAnchor"] = lower
    metadata["upperAnchor"] = upper
    metadata["lowerAnchorRaw"] = float(np.expm1(lower)) if log_transform else lower
    metadata["upperAnchorRaw"] = float(np.expm1(upper)) if log_transform else upper
    transformed_all = np.log1p(numeric) if log_transform else numeric
    if not math.isfinite(lower) or not math.isfinite(upper) or upper <= lower:
        scores.loc[valid_mask] = 0.5
        metadata["collapsedTo"] = 0.5
        return scores, metadata
    scaled = (transformed_all.loc[valid_mask] - lower) / (upper - lower)
    scores.loc[valid_mask] = scaled.clip(0.0, 1.0)
    return scores, metadata


def combine_opportunity_score(
    heat: float,
    no_int: float,
    ca: float,
    price: float,
) -> tuple[float, float, str]:
    components = {"heat": heat, "no_int": no_int, "ca": ca, "price": price}
    active_weight = 0.0
    weighted = 0.0
    for name, value in components.items():
        if value is None or pd.isna(value) or not math.isfinite(float(value)):
            continue
        weight = FIXED_WEIGHTS[name]
        active_weight += weight
        weighted += weight * float(value)
    if active_weight + 1e-12 < MIN_ACTIVE_WEIGHT:
        return np.nan, round(active_weight, 2), "INSUFFICIENT_METRICS"
    status = "FULL_4D_RANKING_ONLY" if active_weight + 1e-12 >= 1 else "PARTIAL_RENORMALIZED"
    return round(100 * weighted / active_weight, 2), round(active_weight, 2), status


def compute_robust_opportunity_scores(
    eligible_df: pd.DataFrame, config: RuntimeConfig
) -> pd.DataFrame:
    df = eligible_df.copy()
    if "avgCaRub_effective" not in df:
        df["avgCaRub_effective"] = df.get("avgCaRub", pd.Series(np.nan, index=df.index))
    if "price_obs_status" not in df:
        df["price_obs_status"] = "OBSERVED"
    quantiles = config.thresholds["robust_scale_quantiles"]
    price_cap = math.log1p(config.thresholds["avg_price_cross_border_safe_max_rub"])
    no_int_cap = min(85.0, config.thresholds["no_interaction_dead_bounce_max_pct"])
    scaling: dict[str, Any] = {}
    df["S_heat"], scaling["heat"] = scale_robust(df["count"], quantiles, log_transform=True)
    df["S_no_int"], scaling["no_int"] = scale_robust(
        df["usersWithoutInterectionShare"], quantiles, upper_anchor_cap=no_int_cap
    )
    df["S_ca"], scaling["ca"] = scale_robust(df["ca"], quantiles)
    df["S_price"], scaling["price"] = scale_robust(
        df["avgCaRub_effective"], quantiles, log_transform=True, positive_only=True, upper_anchor_cap=price_cap
    )
    combined = [
        combine_opportunity_score(row.S_heat, row.S_no_int, row.S_ca, row.S_price)
        for row in df.itertuples()
    ]
    df["Opportunity_Score"] = [item[0] for item in combined]
    df["active_weight_sum"] = [item[1] for item in combined]
    df["score_status"] = [item[2] for item in combined]
    df.attrs["scaling"] = scaling
    return df


def numeric_at_least(row: pd.Series, field: str, threshold: float) -> bool:
    value = row.get(field)
    return value is not None and not pd.isna(value) and math.isfinite(float(value)) and float(value) >= threshold


def numeric_at_most(row: pd.Series, field: str, threshold: float) -> bool:
    value = row.get(field)
    return value is not None and not pd.isna(value) and math.isfinite(float(value)) and float(value) <= threshold


def numeric_between(row: pd.Series, field: str, lower: float, upper: float) -> bool:
    return numeric_at_least(row, field, lower) and numeric_at_most(row, field, upper)


def classify_four_quadrants(scored_df: pd.DataFrame, config: RuntimeConfig) -> pd.DataFrame:
    df = scored_df.copy()
    thresholds = config.thresholds
    row_results: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        price_field = "avgCaRub_effective"
        blue = (
            numeric_between(
                row, "count", thresholds["count_days7_niche_min"], thresholds["count_days7_sweet_spot_max"]
            )
            and numeric_between(
                row,
                "usersWithoutInterectionShare",
                thresholds["no_interaction_gap_min_pct"],
                thresholds["no_interaction_dead_bounce_max_pct"],
            )
            and (
                numeric_at_most(row, "uniqSellers", thresholds["uniq_sellers_low_density_max"])
                or numeric_at_least(row, "zrShare", thresholds["zr_share_signal_min_pct"])
            )
            and numeric_at_least(row, "ord", thresholds["ord_commercial_proof_min_buyers"])
            and numeric_between(
                row,
                price_field,
                thresholds["avg_price_fbs_viable_floor_rub"],
                thresholds["avg_price_cross_border_safe_max_rub"],
            )
        )
        high_conversion = (
            numeric_at_least(row, "count", thresholds["count_days7_niche_min"])
            and numeric_at_least(row, "ca", thresholds["ca_high_demand_min_pct"])
            and numeric_at_least(row, "searchUsersToOrdUsers", thresholds["ord_conv_rigid_min_pct"])
            and numeric_at_least(row, "ord", thresholds["ord_rigid_demand_min_buyers"])
            and numeric_between(
                row,
                price_field,
                thresholds["avg_price_high_conversion_floor_rub"],
                thresholds["avg_price_cross_border_safe_max_rub"],
            )
        )
        high_ticket = (
            numeric_between(
                row, "count", thresholds["count_days7_valid_floor"], thresholds["count_days7_sweet_spot_max"]
            )
            and numeric_between(
                row,
                price_field,
                thresholds["avg_price_high_ticket_min_rub"],
                thresholds["avg_price_cross_border_safe_max_rub"],
            )
            and numeric_at_least(row, "ord", 100)
            and numeric_at_least(row, "ca", thresholds["ca_high_ticket_min_pct"])
        )
        hits = [label for label, matched in zip(QUADRANT_PRIORITY, (blue, high_conversion, high_ticket)) if matched]
        primary = hits[0] if hits else REGULAR_QUADRANT
        risks: list[str] = []
        quality: list[str] = []
        if numeric_at_least(row, "ord", 0) and float(row["ord"]) == 0 and numeric_at_least(
            row, "usersWithoutInterectionShare", thresholds["no_interaction_dead_bounce_max_pct"] + 1e-9
        ) and float(row["usersWithoutInterectionShare"]) > thresholds["no_interaction_dead_bounce_max_pct"]:
            risks.append("ZERO_ORDER_DEAD_BOUNCE")
            quality.append("WARN_ZERO_ORDER_HIGH_BOUNCE")
        if numeric_at_least(row, "count", thresholds["count_days7_broad_head_warn"] + 1e-9) and float(
            row["count"]
        ) > thresholds["count_days7_broad_head_warn"]:
            risks.append("BROAD_MEGA_TERM")
            quality.append("WARN_BROAD_HEAD_TERM")
            if numeric_at_least(row, "uniqSellers", 35):
                risks.append("BROAD_RED_OCEAN_HEAD_TERM")
        price = row.get("avgCaRub_effective")
        if price is not None and not pd.isna(price):
            if float(price) > thresholds["avg_price_extreme_outlier_rub"]:
                risks.append("EXTREME_PRICE_OUTLIER")
                quality.append("WARN_EXTREME_PRICE_OUTLIER")
            elif float(price) > thresholds["avg_price_cross_border_safe_max_rub"]:
                risks.append("PRICE_ABOVE_SAFE_BAND")
                quality.append("WARN_PRICE_ABOVE_SAFE_BAND")
            elif 0 < float(price) < thresholds["avg_price_fbs_viable_floor_rub"]:
                risks.append("LOW_TICKET_FBS_MARGIN_HIGH_RISK")
                quality.append("LOW_TICKET_FBS_MARGIN_HIGH_RISK")
        if row.get("price_obs_status") == "UNOBSERVED_NO_CART":
            quality.append("PARTIAL_PRICE_UNOBSERVED")
        if not quality:
            quality.append(
                "NUMERIC_FULL_4D_ONLY" if row.get("score_status") == "FULL_4D_RANKING_ONLY" else "PARTIAL_METRICS"
            )
        if primary == REGULAR_QUADRANT:
            if "BROAD_MEGA_TERM" in risks:
                sub_pool = "BROAD_MEGA_TERM"
            elif "EXTREME_PRICE_OUTLIER" in risks or "PRICE_ABOVE_SAFE_BAND" in risks:
                sub_pool = "EXTREME_HIGH_PRICE_REVIEW"
            elif "LOW_TICKET_FBS_MARGIN_HIGH_RISK" in risks:
                sub_pool = "LOW_PRICE_FBS_SQUEEZE"
            elif row.get("score_status") == "INSUFFICIENT_METRICS":
                sub_pool = "INSUFFICIENT_METRICS"
            else:
                sub_pool = "STANDARD_OBSERVATION"
        else:
            sub_pool = "SPECIAL_QUADRANT_PENDING_REVIEW"
        row_results.append(
            {
                "all_matched_quadrants": "|".join(hits) if hits else REGULAR_QUADRANT,
                "primary_quadrant": primary,
                "quadrant_hypothesis_note": "CANDIDATE_HYPOTHESIS_ONLY_待核非授权",
                "risk_flags": "|".join(risks),
                "data_quality_status": "|".join(dict.fromkeys(quality)),
                "sub_pool_reason": sub_pool,
            }
        )
    result_columns = [
        "all_matched_quadrants", "primary_quadrant", "quadrant_hypothesis_note",
        "risk_flags", "data_quality_status", "sub_pool_reason",
    ]
    results = pd.DataFrame(row_results, index=df.index, columns=result_columns)
    for column in result_columns:
        df[column] = results[column]
    return df


def empty_wordstat_meta(enabled: bool = False) -> dict[str, Any]:
    return {
        "enabled": enabled,
        "status": "NOT_REQUESTED" if not enabled else "UNCERTAIN",
        "sourceAsOf": None,
        "periodWindow": None,
        "receiptSha256": None,
        "receiptFileSha256": None,
        "error": None,
    }


def normalize_window(value: Any) -> Any:
    return json_safe(value)


def load_wordstat_receipt(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    meta = empty_wordstat_meta(True)
    meta["receiptFileSha256"] = sha256_file(path)
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        meta["error"] = f"回执读取或JSON解析失败: {exc}"
        return [], meta
    if isinstance(document, list):
        document = {"records": document}
    if not isinstance(document, dict):
        meta["error"] = "回执顶层不是对象或数组"
        return [], meta
    meta["sourceAsOf"] = document.get("sourceAsOf")
    meta["periodWindow"] = normalize_window(document.get("periodWindow"))
    meta["receiptSha256"] = document.get("receiptSha256") or document.get("hash")
    records = document.get("records")
    if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
        meta["error"] = "回执缺少合法records数组"
        return [], meta
    meta["status"] = "LOADED"
    return records, meta


def wordstat_record_result(record: Mapping[str, Any]) -> tuple[str, float]:
    status = str(record.get("status") or "UNCERTAIN").upper()
    if status in {"MISSING", "NOT_FOUND"}:
        return "MISSING", np.nan
    if status not in {"VALID", "OK", "SUCCESS", "COMPLETED"}:
        return "UNCERTAIN", np.nan
    value, error = parse_numeric(record.get("totalCount"))
    if error or pd.isna(value) or value < 0:
        return "UNCERTAIN", np.nan
    return "VALID", value


def attach_wordstat_cross_check(
    tagged_df: pd.DataFrame, wordstat_receipt_path: str | Path | None = None
) -> tuple[pd.DataFrame, dict[str, Any]]:
    df = tagged_df.copy()
    if wordstat_receipt_path is None:
        meta = empty_wordstat_meta(False)
        records: list[dict[str, Any]] = []
    else:
        path = Path(wordstat_receipt_path)
        if not path.is_file():
            meta = empty_wordstat_meta(True)
            meta["error"] = f"回执文件不存在: {path}"
            records = []
        else:
            records, meta = load_wordstat_receipt(path)
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for record in records:
        key = normalize_query(record.get("query"))
        if key:
            grouped.setdefault(key, []).append(record)
    statuses: list[str] = []
    counts: list[float] = []
    item_as_of: list[Any] = []
    item_windows: list[Any] = []
    item_hashes: list[Any] = []
    for _, row in df.iterrows():
        key = normalize_query(row.get("query"))
        if not meta["enabled"]:
            status, count = "NOT_REQUESTED", np.nan
            matches: list[Mapping[str, Any]] = []
        elif meta["status"] != "LOADED":
            status, count = "UNCERTAIN", np.nan
            matches = []
        else:
            matches = grouped.get(key, [])
            if not matches:
                status, count = "MISSING", np.nan
            elif len(matches) > 1:
                status, count = "UNCERTAIN", np.nan
            else:
                status, count = wordstat_record_result(matches[0])
        record = matches[0] if len(matches) == 1 else {}
        statuses.append(status)
        counts.append(count)
        item_as_of.append(record.get("sourceAsOf") or meta["sourceAsOf"] or None)
        window = record.get("periodWindow")
        if window is None and (record.get("rawPeriodStart") or record.get("rawPeriodEnd")):
            window = {"start": record.get("rawPeriodStart"), "end": record.get("rawPeriodEnd")}
        item_windows.append(normalize_window(window if window is not None else meta["periodWindow"]))
        item_hashes.append(record.get("receiptSha256") or meta["receiptSha256"] or meta["receiptFileSha256"])
    df["ws_status"] = statuses
    df["ws_count"] = counts
    df["ws_sourceAsOf"] = item_as_of
    df["ws_periodWindow"] = [json.dumps(json_safe(value), ensure_ascii=False) if value is not None else None for value in item_windows]
    df["ws_receiptHash"] = item_hashes
    df["ws_sourceAsOf_and_window"] = [
        None if as_of is None and window is None else f"sourceAsOf={as_of or 'N/A'} | window={window or 'N/A'}"
        for as_of, window in zip(item_as_of, df["ws_periodWindow"])
    ]
    df["evidence_status"] = [
        "SELLER_7D_PLUS_WORDSTAT_VALID" if status == "VALID"
        else "SELLER_7D_WORDSTAT_MISSING_OR_UNCERTAIN" if status in {"MISSING", "UNCERTAIN"}
        else "SELLER_7D_NATIVE_ONLY"
        for status in statuses
    ]
    meta["counts"] = {
        status: int(sum(item == status for item in statuses))
        for status in ("VALID", "MISSING", "UNCERTAIN", "NOT_REQUESTED")
    }
    return df, meta


def load_translation_overrides(source: str | Path | Mapping[str, Any] | None) -> dict[str, Any]:
    if source is None:
        return {}
    if isinstance(source, Mapping):
        document = dict(source)
    else:
        document = read_yaml(Path(source))
    entries = document.get("queries", document.get("overrides", document))
    if not isinstance(entries, dict):
        raise AnalyzerInputError("translation overrides必须是查询词映射或包含queries对象")
    normalized: dict[str, Any] = {}
    for query, value in entries.items():
        key = normalize_query(query)
        if not key:
            continue
        if isinstance(value, str):
            normalized[key] = {"cn_gloss": value}
        elif isinstance(value, dict):
            normalized[key] = value
        else:
            raise AnalyzerInputError(f"翻译覆盖项{query!r}必须是字符串或对象")
    return normalized


def parse_review_flags(value: Any) -> list[str]:
    if value is None or value is pd.NA or (isinstance(value, float) and math.isnan(value)):
        return []
    raw_items = [value] if isinstance(value, str) else value
    if not isinstance(raw_items, (list, tuple)):
        raise AnalyzerInputError("review_flags必须是数组或|分隔字符串")
    flags: list[str] = []
    for item in raw_items:
        if not isinstance(item, str):
            raise AnalyzerInputError("review_flags数组元素必须是字符串")
        for part in item.split("|"):
            flag = part.strip().upper()
            if flag and flag not in flags:
                flags.append(flag)
    return flags


def draft_text(value: Any, fallback: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        text = fallback
    return text if text.startswith("[待审草稿]") else f"[待审草稿] {text}"


def generate_links_and_draft_placeholders(
    df: pd.DataFrame,
    translation_overrides: str | Path | Mapping[str, Any] | None = None,
) -> pd.DataFrame:
    result = df.copy()
    overrides = load_translation_overrides(translation_overrides)
    ozon_urls: list[str] = []
    yandex_urls: list[str] = []
    wordstat_urls: list[str] = []
    glosses: list[str] = []
    forms: list[str] = []
    override_statuses: list[str] = []
    manual_review_flags: list[str] = []
    for _, row in result.iterrows():
        query = str(row.get("query") or "").strip()
        encoded = quote_plus(query)
        ozon_urls.append(f"https://www.ozon.ru/search/?text={encoded}&from_global=true")
        yandex_urls.append(f"https://yandex.ru/search/?text={encoded}")
        wordstat_urls.append(f"https://wordstat.yandex.ru/?region=225&view=table&words={encoded}")
        override = overrides.get(normalize_query(query), {})
        glosses.append(draft_text(override.get("cn_gloss"), "待Kimi复核中文释义"))
        forms.append(
            draft_text(
                override.get("form_hypothesis") or override.get("form"),
                "待Kimi复核产品形态；不推断材质、规格、OE、重量或合规",
            )
        )
        override_statuses.append("APPLIED_PENDING_KIMI_REVIEW" if override else "NOT_PROVIDED")
        manual_review_flags.append("|".join(parse_review_flags(override.get("review_flags"))))
    result["ozon_search_url"] = ozon_urls
    result["yandex_search_url"] = yandex_urls
    result["wordstat_url"] = wordstat_urls
    result["cn_gloss_draft"] = glosses
    result["form_hypothesis_draft"] = forms
    result["translation_override_status"] = override_statuses
    result["manual_review_flags"] = manual_review_flags
    result["mandatory_pending_actions"] = MANDATORY_PENDING_ACTIONS
    return result


def calculate_reverse_fbs_hurdles(
    df: pd.DataFrame, config: RuntimeConfig | None = None
) -> pd.DataFrame:
    result = df.copy()
    thresholds = config.thresholds if config else DEFAULT_THRESHOLDS
    price_floor = thresholds["avg_price_fbs_viable_floor_rub"]
    price_ceiling = thresholds["avg_price_cross_border_safe_max_rub"]
    flags: list[str] = []
    for _, row in result.iterrows():
        price = row.get("avgCaRub_effective")
        if price is None or pd.isna(price) or float(price) <= 0:
            flags.append("PRICE_UNOBSERVED")
        elif float(price) < price_floor:
            flags.append("LOW_TICKET_FBS_MARGIN_HIGH_RISK")
        elif float(price) <= price_ceiling:
            flags.append("FBS_RFBS_PRICE_BAND_PRECHECK_ONLY")
        else:
            flags.append("ABOVE_CROSS_BORDER_SAFE_BAND")
    result["fbs_price_band_flag"] = flags
    result["max_total_cost_rub_10pct"] = np.nan
    result["max_total_cost_rub_15pct"] = np.nan
    result["max_cny_budget_est_hint"] = np.nan
    result["economics_gate_status"] = "PENDING_REAL_COSTS_NO_NUMERIC_CAP"
    result["economics_pending_inputs"] = PENDING_ECONOMICS_INPUTS
    result["content_gate_status"] = "PENDING_8_IMAGES_AND_2_VIDEOS"
    return result


def apply_top30_eligibility(
    df: pd.DataFrame, config: RuntimeConfig | None = None
) -> pd.DataFrame:
    thresholds = config.thresholds if config else DEFAULT_THRESHOLDS
    price_floor = thresholds["avg_price_fbs_viable_floor_rub"]
    price_ceiling = thresholds["avg_price_cross_border_safe_max_rub"]
    ca_floor = thresholds["ca_viable_floor_pct"]
    search_to_ord_floor = thresholds["top30_min_search_to_ord_pct"]
    eligible_mask: list[bool] = []
    reasons: list[str] = []
    for _, row in df.iterrows():
        price = row.get("avgCaRub_effective")
        price_ok = price is not None and not pd.isna(price) and price_floor <= float(price) <= price_ceiling
        score = row.get("Opportunity_Score")
        score_ok = (
            score is not None
            and not pd.isna(score)
            and math.isfinite(float(score))
            and numeric_at_least(row, "active_weight_sum", MIN_ACTIVE_WEIGHT)
        )
        special_quadrant = row.get("primary_quadrant") in QUADRANT_PRIORITY
        risk_free = not row.get("risk_flags")
        economics_ok = row.get("economics_gate_status") == "PENDING_REAL_COSTS_NO_NUMERIC_CAP"
        manual_review_blocked = bool(
            set(parse_review_flags(row.get("manual_review_flags"))) & MANUAL_REVIEW_TOP30_BLOCKERS
        )
        ca_present = row.get("ca") is not None and not pd.isna(row.get("ca"))
        search_present = (
            row.get("searchUsersToOrdUsers") is not None
            and not pd.isna(row.get("searchUsersToOrdUsers"))
        )
        commercial_intent_ok = (
            numeric_at_least(row, "ca", ca_floor)
            and numeric_at_least(row, "searchUsersToOrdUsers", search_to_ord_floor)
        )
        eligible = (
            special_quadrant
            and score_ok
            and risk_free
            and price_ok
            and economics_ok
            and commercial_intent_ok
            and not manual_review_blocked
        )
        eligible_mask.append(bool(eligible))
        if manual_review_blocked:
            reasons.append("MANUAL_IDENTITY_REVIEW")
        elif eligible:
            reasons.append("ELIGIBLE_PENDING_REVIEW")
        elif not special_quadrant:
            reasons.append("REGULAR_QUADRANT")
        elif not score_ok:
            reasons.append("SCORE_INSUFFICIENT")
        elif not price_ok or not risk_free:
            reasons.append("PRICE_OR_RISK")
        elif not economics_ok:
            reasons.append("ECONOMICS_GATE")
        elif not ca_present or not search_present:
            reasons.append("MISSING_COMMERCIAL_INTENT")
        else:
            reasons.append("LOW_COMMERCIAL_INTENT")
    result = df.copy()
    result["top30_eligible"] = pd.Series(eligible_mask, index=result.index, dtype=bool)
    result["top30_exclusion_reason"] = pd.Series(reasons, index=result.index, dtype=object)
    return result


def select_top30(df: pd.DataFrame, config: RuntimeConfig | None = None) -> pd.DataFrame:
    result = (
        df.copy()
        if {"top30_eligible", "top30_exclusion_reason"}.issubset(df.columns)
        else apply_top30_eligibility(df, config)
    )
    top = result.loc[result["top30_eligible"]].sort_values(
        ["Opportunity_Score", "original_row_id"], ascending=[False, True], kind="mergesort"
    ).head(30).copy()
    if "rank_in_batch" in top:
        top = top.drop(columns="rank_in_batch")
    top.insert(0, "rank_in_batch", range(1, len(top) + 1))
    return top.reset_index(drop=True)


def quantile_snapshot(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    snapshot: dict[str, dict[str, Any]] = {}
    for field in NUMERIC_FIELDS:
        if field not in df:
            snapshot[field] = {key: None for key in ("present", "missing", "min", "p05", "p50", "p90", "p95", "max")}
            snapshot[field]["present"] = 0
            snapshot[field]["missing"] = len(df)
            continue
        series = pd.to_numeric(df[field], errors="coerce")
        present = series.dropna()
        item: dict[str, Any] = {
            "present": int(present.size),
            "missing": int(series.isna().sum()),
        }
        for key in ("min", "p05", "p50", "p90", "p95", "max"):
            item[key] = None
        if not present.empty:
            item.update(
                {
                    "min": float(present.min()),
                    "p05": float(present.quantile(0.05)),
                    "p50": float(present.quantile(0.50)),
                    "p90": float(present.quantile(0.90)),
                    "p95": float(present.quantile(0.95)),
                    "max": float(present.max()),
                }
            )
        snapshot[field] = item
    return snapshot


TOP_COLUMNS = [
    "rank_in_batch", "query", "token_cluster_id", "cluster_size_in_batch",
    "cn_gloss_draft", "form_hypothesis_draft", "manual_review_flags",
    "primary_quadrant", "all_matched_quadrants",
    "Opportunity_Score", "score_status", "data_quality_status", "evidence_status", "count",
    "usersWithoutInterectionShare", "ca", "ord", "searchUsersToOrdUsers", "avgCaRub",
    "uniqSellers", "zrShare", "gmv", "ws_count", "ws_status", "ws_sourceAsOf_and_window",
    "max_total_cost_rub_15pct", "max_total_cost_rub_10pct", "economics_gate_status",
    "economics_pending_inputs", "content_gate_status", "ozon_search_url", "yandex_search_url",
    "wordstat_url", "mandatory_pending_actions",
]
DETAIL_COLUMNS = [
    "original_row_id", "query", "query_norm", "token_cluster_id", "cluster_size_in_batch",
    "primary_quadrant", "all_matched_quadrants", "sub_pool_reason", "quadrant_hypothesis_note",
    "Opportunity_Score", "S_heat", "S_no_int", "S_ca", "S_price", "active_weight_sum",
    "score_status", "data_quality_status", "risk_flags", "top30_eligible", "top30_exclusion_reason",
    "evidence_status", "count",
    "uniqQueriesWCa", "ca", "ord", "searchUsersToOrdUsers", "gmv", "avgCaRub",
    "avgCaRub_effective", "price_obs_status", "itemsViews", "uniqSellers",
    "usersWithoutInterectionCount", "usersWithoutInterectionShare", "zrCount", "zrShare",
    "dynamic7", "dynamic28", "ws_count", "ws_status", "ws_sourceAsOf", "ws_periodWindow",
    "ws_receiptHash", "fbs_price_band_flag", "max_total_cost_rub_10pct",
    "max_total_cost_rub_15pct", "economics_gate_status", "economics_pending_inputs",
    "content_gate_status", "cn_gloss_draft", "form_hypothesis_draft", "translation_override_status",
    "manual_review_flags", "ozon_search_url", "yandex_search_url", "wordstat_url", "mandatory_pending_actions",
]
FILTER_COLUMNS = [
    "original_row_id", "query", "filter_category", "all_filter_categories", "matched_rule_id",
    "matched_keyword_or_pattern", "filter_explanation", "count", "ca", "ord", "avgCaRub",
    "usersWithoutInterectionShare", "governance_audit_json",
]
QUARANTINE_COLUMNS = [
    "original_row_id", "raw_query", "isolation_type", "isolation_detail", "kept_master_row_id",
    "raw_row_json_snapshot",
]
URL_COLUMNS = {
    "ozon_search_url": "Ozon调研",
    "yandex_search_url": "Yandex调研",
    "wordstat_url": "Wordstat调研",
}
ILLEGAL_XML_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def excel_safe_string(value: str) -> str:
    value = ILLEGAL_XML_CHARS.sub("", value)
    if value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def excel_value(value: Any) -> Any:
    if value is None or value is pd.NA:
        return "N/A"
    if isinstance(value, (float, np.floating)) and not math.isfinite(float(value)):
        return "N/A"
    try:
        if pd.isna(value):
            return "N/A"
    except (TypeError, ValueError):
        pass
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, (dict, list, tuple)):
        value = json.dumps(json_safe(value), ensure_ascii=False)
    if isinstance(value, str):
        return excel_safe_string(value)
    return value


def write_dataframe_sheet(
    workbook: Workbook,
    name: str,
    df: pd.DataFrame,
    columns: Sequence[str],
    warning: str | None = None,
) -> None:
    sheet = workbook.create_sheet(name)
    header_row = 2 if warning else 1
    if warning:
        sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(1, len(columns)))
        cell = sheet.cell(1, 1, excel_safe_string(warning))
        cell.fill = PatternFill("solid", fgColor="1F4E78")
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        sheet.row_dimensions[1].height = 34
    for column_index, column in enumerate(columns, start=1):
        cell = sheet.cell(header_row, column_index, column)
        cell.fill = PatternFill("solid", fgColor="D9EAF7")
        cell.font = Font(bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    for row_offset, (_, row) in enumerate(df.iterrows(), start=1):
        for column_index, column in enumerate(columns, start=1):
            value = row.get(column)
            cell = sheet.cell(header_row + row_offset, column_index)
            if column in URL_COLUMNS:
                if value is not None and not pd.isna(value) and str(value):
                    cell.value = URL_COLUMNS[column]
                    cell.hyperlink = str(value)
                    cell.style = "Hyperlink"
                else:
                    cell.value = "N/A"
            else:
                cell.value = excel_value(value)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            if column in PERCENT_FIELDS and isinstance(cell.value, numbers.Real):
                cell.number_format = '0.00"%"'
            elif column in {"Opportunity_Score", "S_heat", "S_no_int", "S_ca", "S_price", "active_weight_sum"} and isinstance(cell.value, numbers.Real):
                cell.number_format = "0.0000"
            elif column in {"count", "gmv", "avgCaRub", "avgCaRub_effective", "ord", "uniqSellers"} and isinstance(cell.value, numbers.Real):
                cell.number_format = "#,##0.00"
    last_row = header_row + len(df)
    sheet.auto_filter.ref = f"A{header_row}:{get_column_letter(max(1, len(columns)))}{last_row}"
    sheet.freeze_panes = f"A{header_row + 1}"
    for index, column in enumerate(columns, start=1):
        width = min(60, max(12, len(column) + 2))
        if column in {"query", "cn_gloss_draft", "form_hypothesis_draft", "mandatory_pending_actions", "economics_pending_inputs", "filter_explanation", "isolation_detail"}:
            width = 42
        sheet.column_dimensions[get_column_letter(index)].width = width


def metadata_rows(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def visit(value: Any, path: tuple[str, ...]) -> None:
        if isinstance(value, Mapping):
            for key, item in value.items():
                visit(item, path + (str(key),))
        else:
            if isinstance(value, (list, tuple)):
                rendered = json.dumps(json_safe(value), ensure_ascii=False)
            else:
                rendered = value
            rows.append(
                {
                    "section": path[0] if path else "root",
                    "key": ".".join(path),
                    "value": rendered,
                }
            )

    visit(manifest, ())
    for boundary in GOVERNANCE_BOUNDARIES:
        rows.append({"section": "governanceBoundary", "key": "非授权与口径边界", "value": boundary})
    return rows


def markdown_value(value: Any, digits: int = 2) -> str:
    if value is None or value is pd.NA:
        return "N/A"
    if isinstance(value, (float, np.floating)):
        if not math.isfinite(float(value)):
            return "N/A"
        return f"{float(value):,.{digits}f}"
    try:
        if pd.isna(value):
            return "N/A"
    except (TypeError, ValueError):
        pass
    return str(value).replace("\n", " ").replace("\r", " ")


def markdown_query(value: Any) -> str:
    return str(value).replace("`", "'").replace("\n", " ").replace("\r", " ")


def render_markdown_brief(top30: pd.DataFrame, manifest: Mapping[str, Any]) -> str:
    top10 = top30.head(10)
    funnel = manifest["filterFunnel"]
    full_count_p50 = markdown_value(manifest["quantiles"]["count"]["p50"])
    eligible_count_p50 = markdown_value(manifest["eligibleQuantiles"]["count"]["p50"])
    commercial_gate = manifest["parameters"]["top30CommercialIntentGate"]
    lines = [
        f"# Ozon Seller 搜索词选品待核简报（Top {len(top10)}）",
        "",
        "> **仅作离线调研排序，非立项、采购、拿样、调价、广告、付费制作或上架授权。候选不足不补。**",
        "",
        "## 批次口径与过滤漏斗",
        "",
        f"- `runId`: `{markdown_value(manifest.get('runId'))}`；`anchorAt`: `{markdown_value(manifest.get('anchorAt'))}`；输入 SHA-256: `{manifest['hash']}`。",
        "- 默认采用 **days_7 calibrated profile**。`count` 是 Ozon Seller 原生相对7天市场查询热度，不是月搜索量或可累加次数，也不是本店SKU漏斗。",
        f"- 原始 {funnel['rawRows']} 行；异常与重复隔离 {funnel['quarantineAndDuplicates']} 行；治理过滤 {funnel['governanceFiltered']} 行；进入明细 {funnel['eligibleRows']} 行；Top30实际 {funnel['top30Actual']} 行。",
        f"- 分位数双口径：`quantiles`=清洗+精确去重后、治理过滤前的完整有效唯一词分布（count P50={full_count_p50}）；`eligibleQuantiles`=治理过滤后明细分布（count P50={eligible_count_p50}）。前者用于原始基准核对，二者不得混用。",
        "- 固定权重：heat=0.30 / no_int=0.35 / ca=0.25 / price=0.10；有效权重低于0.65不评分，Wordstat不混入主评分。",
        f"- **Top30 额外商业意图底线**：ca >= {commercial_gate['caMinPct']:g}%、searchUsersToOrdUsers >= {commercial_gate['searchUsersToOrdUsersMinPct']:g}%；任一缺失均不准入且不补0。既有象限标签保留，但高分或高无交互不等于蓝海，更不是行动授权。",
        "- **人工风险闸门**：translation overrides 的 `review_flags` 写入 `manual_review_flags`；含 `AMBIGUOUS_IDENTITY` 或 `BRAND_REVIEW_REQUIRED` 的查询行一律以 `MANUAL_IDENTITY_REVIEW` 阻断 Top30，但保留明细和四象限待核标签。",
        "- `NUMERIC_FULL_4D_ONLY` 仅表示四维评分输入数值完整，不代表商品身份、合规、供货、经济或商业 PASS。",
        "- **Top30/Top10 是查询行，不是独立方向或合格 SKU**；同词序簇与其他相关词必须合并调研，不得按查询行数计算独立方向数。",
        "- Seller `days_7` 只有相对7天口径，日历起止与时区未知；`ord` 是下单独立买家而非订单/件数，`gmv` 是按查询归因的订购金额而非结算收入，`avgCaRub` 不是本店可实现成交价；`itemsViews` 是展示商品数量。",
        "",
        "## Top10 待核查询行（与 Top30 Sheet 同源截取；非独立方向或合格 SKU）",
        "",
    ]
    if top10.empty:
        lines.extend(["**本批无符合专项象限、评分、商业意图、风险与价格带初筛的候选；不以常规词或过滤词凑数。**", ""])
    for _, row in top10.iterrows():
        lines.extend(
            [
                f"### #{int(row['rank_in_batch'])} `{markdown_query(row['query'])}`",
                "",
                f"- **待审草稿**：{row['cn_gloss_draft']}；{row['form_hypothesis_draft']}。",
                f"- **人工复核标志**：{row.get('manual_review_flags') or 'NONE'}。",
                f"- **待核象限**：{row['primary_quadrant']}（全部命中：{row['all_matched_quadrants']}）；排序分 {markdown_value(row['Opportunity_Score'])}/100；质量 `{row['data_quality_status']}`。",
                f"- **Seller days_7 原值**：count={markdown_value(row['count'])}（热度非次数），无交互={markdown_value(row['usersWithoutInterectionShare'])}%，ca={markdown_value(row['ca'])}%，ord={markdown_value(row['ord'])}（下单独立买家，非订单/件数），搜索转下单={markdown_value(row['searchUsersToOrdUsers'])}%，gmv={markdown_value(row['gmv'])} RUB（订购金额，非结算收入），avgCaRub={markdown_value(row['avgCaRub'])} RUB（非CPC/非本店可实现成交价），itemsViews={markdown_value(row['itemsViews'])}（展示商品数量），卖家数={markdown_value(row['uniqSellers'])}，零结果份额={markdown_value(row['zrShare'])}%。",
                f"- **Wordstat 独立回执**：`{row['ws_status']}`；数值={markdown_value(row['ws_count'])}；{markdown_value(row['ws_sourceAsOf_and_window'])}；hash=`{markdown_value(row['ws_receiptHash'])}`。",
                "- **跨境 FBS/rFBS 经济门禁**：持续净利率>=10%才可测、>=15%优先；真实成本未齐，10%/15%成本上限均为 **N/A**，不使用默认25%毛利、FBO假设或占位费率。",
                f"- **必须待核**：{row['mandatory_pending_actions']}。",
                f"- **调研链接**：[Ozon]({row['ozon_search_url']}) | [Yandex]({row['yandex_search_url']}) | [Wordstat]({row['wordstat_url']})。",
                "",
            ]
        )
    lines.extend(
        [
            "## 统一治理边界",
            "",
            *[f"- {boundary}" for boundary in GOVERNANCE_BOUNDARIES],
            "",
            "后续仍须真实供货与准确变体核验、完整8图+双视频、独立复核；本工具不会自动上架、采购、拿样、调价、开广告或发起付费制作。",
            "",
        ]
    )
    return "\n".join(lines)


def export_excel_and_markdown_reports(
    output_dir: str | Path,
    eligible_df: pd.DataFrame,
    top30: pd.DataFrame,
    filtered_df: pd.DataFrame,
    quarantine_df: pd.DataFrame,
    manifest: dict[str, Any],
) -> dict[str, Path]:
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    excel_path = output / OUTPUT_EXCEL
    brief_path = output / OUTPUT_BRIEF
    manifest_path = output / OUTPUT_MANIFEST
    workbook = Workbook()
    workbook.remove(workbook.active)
    meta_df = pd.DataFrame(metadata_rows(manifest), columns=["section", "key", "value"])
    write_dataframe_sheet(
        workbook,
        "00_批次口径与回执元数据",
        meta_df,
        ["section", "key", "value"],
        "离线只读分析；days_7口径；非任何生产或经营动作授权",
    )
    write_dataframe_sheet(
        workbook,
        "Top30_立项推荐",
        top30,
        TOP_COLUMNS,
        "仅作调研排序待核 · 非立项/采购/上架授权 · 不足30条按实输出绝不伪造",
    )
    write_dataframe_sheet(workbook, "四象限分类明细", eligible_df, DETAIL_COLUMNS)
    write_dataframe_sheet(workbook, "品牌词过滤记录", filtered_df, FILTER_COLUMNS)
    write_dataframe_sheet(workbook, "不合格与异常隔离", quarantine_df, QUARANTINE_COLUMNS)
    workbook.save(excel_path)
    brief_path.write_text(render_markdown_brief(top30, manifest), encoding="utf-8")
    manifest["outputs"] = {
        "excel": {"fileName": OUTPUT_EXCEL, "sha256": sha256_file(excel_path)},
        "brief": {"fileName": OUTPUT_BRIEF, "sha256": sha256_file(brief_path)},
        "manifest": {"fileName": OUTPUT_MANIFEST},
    }
    manifest_path.write_text(
        json.dumps(json_safe(manifest), ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return {"excel": excel_path, "brief": brief_path, "manifest": manifest_path}


def load_source_metadata(path: str | Path | None) -> dict[str, Any]:
    if path is None:
        return {"nativePeriod": "days_7", "nativePeriodSource": "TOOL_DEFAULT_CALIBRATED_PROFILE"}
    metadata_path = Path(path)
    if not metadata_path.is_file():
        raise AnalyzerInputError(f"source metadata JSON不存在: {metadata_path}")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AnalyzerInputError(f"source metadata读取失败: {exc}") from exc
    if not isinstance(metadata, dict):
        raise AnalyzerInputError("source metadata顶层必须是JSON对象")
    period = metadata.get("nativePeriod") or "days_7"
    if period != "days_7":
        raise AnalyzerInputError(f"该校准工具仅接受nativePeriod=days_7，实际: {period}")
    metadata["nativePeriod"] = "days_7"
    metadata.setdefault("nativePeriodSource", "SOURCE_METADATA")
    return metadata


def metadata_expected_count(metadata: Mapping[str, Any], key: str) -> int | None:
    if key not in metadata or metadata[key] is None:
        return None
    value = metadata[key]
    if isinstance(value, bool):
        raise AnalyzerInputError(f"{key}必须是非负整数")
    if isinstance(value, str):
        if not value.strip().isdigit():
            raise AnalyzerInputError(f"{key}必须是非负整数，实际: {value!r}")
        return int(value.strip())
    if not isinstance(value, numbers.Real) or not math.isfinite(float(value)) or int(value) != float(value):
        raise AnalyzerInputError(f"{key}必须是非负整数，实际: {value!r}")
    if int(value) < 0:
        raise AnalyzerInputError(f"{key}必须是非负整数，实际: {value!r}")
    return int(value)


def safe_source_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key in (
        "runId", "anchorAt", "nativePeriod", "nativePeriodSource", "metricDefinitionVersion",
        "sourceType", "sha256", "hash", "expectedRows", "expectedUniqueQueries",
        "inputFileSha256", "inputSha256", "fileSha256",
    ):
        if key in metadata:
            safe[key] = json_safe(metadata[key])
    if "contentSha256" in metadata:
        safe["sourceContentSha256"] = json_safe(metadata["contentSha256"])
        safe["sourceContentSha256Comparison"] = "NOT_COMPARABLE_DIFFERENT_SERIALIZATION"
    if "companyId" in metadata:
        safe["companyId"] = "REDACTED"
    return safe


def add_price_observation(df: pd.DataFrame) -> pd.DataFrame:
    result = df.copy()
    avg_price = pd.to_numeric(result.get("avgCaRub"), errors="coerce")
    unique_carts = pd.to_numeric(result.get("uniqQueriesWCa"), errors="coerce")
    result["avgCaRub_effective"] = avg_price.astype(float)
    result["price_obs_status"] = "OBSERVED"
    no_cart_mask = unique_carts.eq(0) & avg_price.eq(0)
    result.loc[no_cart_mask, "avgCaRub_effective"] = np.nan
    result.loc[no_cart_mask, "price_obs_status"] = "UNOBSERVED_NO_CART"
    missing_mask = avg_price.isna()
    result.loc[missing_mask, "price_obs_status"] = "MISSING_NULL"
    non_positive_mask = avg_price.notna() & avg_price.le(0) & ~no_cart_mask
    result.loc[non_positive_mask, "avgCaRub_effective"] = np.nan
    result.loc[non_positive_mask, "price_obs_status"] = "NON_POSITIVE_PRICE_UNOBSERVED"
    return result


def reproduction_argv(args: argparse.Namespace) -> list[str]:
    argv = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--input", str(args.input),
        "--config", str(args.config),
        "--blacklist", str(args.blacklist),
        "--governance-config", str(args.governance_config),
        "--output-dir", str(args.output_dir),
    ]
    for option, attribute in (
        ("--meta", "meta"),
        ("--translation-overrides", "translation_overrides"),
        ("--wordstat-receipt", "wordstat_receipt"),
    ):
        value = getattr(args, attribute)
        if value:
            argv.extend([option, str(value)])
    return argv


def run_analysis(args: argparse.Namespace) -> dict[str, Any]:
    input_path = Path(args.input)
    config = load_runtime_config(args.config, args.blacklist, args.governance_config)
    source_metadata = load_source_metadata(args.meta)
    expected_rows = metadata_expected_count(source_metadata, "expectedRows")
    expected_unique = metadata_expected_count(source_metadata, "expectedUniqueQueries")
    input_hash = sha256_file(input_path)
    mapped, schema_audit = read_and_map_seller_queries(input_path)
    if expected_rows is not None and len(mapped) != expected_rows:
        raise AnalyzerInputError(
            f"expectedRows不一致：metadata={expected_rows}，实际读取={len(mapped)}；拒绝将部分文件作为完整批次"
        )
    valid, invalid = clean_validate_and_quarantine(mapped, config)
    dedup, duplicates = deduplicate_and_cluster_queries(valid)
    if expected_unique is not None and len(dedup) != expected_unique:
        raise AnalyzerInputError(
            f"expectedUniqueQueries不一致：metadata={expected_unique}，清洗并精确去重后={len(dedup)}"
        )
    full_quantiles = quantile_snapshot(dedup)
    eligible, filtered = apply_blacklist_and_shop_direction_guards(dedup, config)
    eligible = add_price_observation(eligible)
    scored = compute_robust_opportunity_scores(eligible, config)
    scaling = scored.attrs.get("scaling", {})
    tagged = classify_four_quadrants(scored, config)
    with_wordstat, wordstat_meta = attach_wordstat_cross_check(tagged, args.wordstat_receipt)
    enriched = generate_links_and_draft_placeholders(with_wordstat, args.translation_overrides)
    enriched = calculate_reverse_fbs_hurdles(enriched, config)
    if not enriched.empty:
        enriched["cluster_size_in_batch"] = enriched.groupby("token_cluster_id")["query"].transform("size")
    else:
        enriched["cluster_size_in_batch"] = pd.Series(dtype=int)
    enriched = apply_top30_eligibility(enriched, config)
    top30 = select_top30(enriched, config)
    quarantine = pd.concat([invalid, duplicates], ignore_index=True, sort=False)
    raw_rows = len(mapped)
    conserved = len(enriched) + len(filtered) + len(quarantine)
    if conserved != raw_rows:
        raise RuntimeError(f"过滤漏斗行数不守恒: 原始{raw_rows}, 输出合计{conserved}")
    category_counts = filtered["filter_category"].value_counts().to_dict() if not filtered.empty else {}
    funnel = {
        "rawRows": raw_rows,
        "invalidRows": len(invalid),
        "exactDuplicatesRemoved": len(duplicates),
        "quarantineAndDuplicates": len(quarantine),
        "brandAndIpFiltered": int(category_counts.get("BRAND_IP_BLACKLIST", 0)),
        "existingPortfolioFiltered": int(category_counts.get("SHOP_EXISTING_SKU", 0)),
        "terminatedDirectionsFiltered": int(category_counts.get("SHOP_TERMINATED_DIRECTION", 0)),
        "nonPurchaseNoiseFiltered": int(category_counts.get("NON_PURCHASE_NOISE", 0)),
        "governanceFiltered": len(filtered),
        "deduplicatedRows": len(dedup),
        "eligibleRows": len(enriched),
        "top30Actual": len(top30),
        "markdownTop10Actual": min(10, len(top30)),
        "conservedRows": conserved,
    }
    declared_input_hashes = {
        key: source_metadata[key]
        for key in ("inputFileSha256", "inputSha256", "fileSha256")
        if source_metadata.get(key) is not None
    }
    hash_match = (
        all(str(value).lower() == input_hash for value in declared_input_hashes.values())
        if declared_input_hashes else None
    )
    content_sha256 = source_metadata.get("contentSha256")
    command_argv = reproduction_argv(args)
    manifest: dict[str, Any] = {
        "toolVersion": TOOL_VERSION,
        "analysisMode": "OFFLINE_READONLY",
        "profile": PROFILE,
        "runId": source_metadata.get("runId", "UNPROVIDED"),
        "anchorAt": source_metadata.get("anchorAt"),
        "nativePeriod": "days_7",
        "nativePeriodDescription": "Ozon Seller原生相对7天市场查询口径；日历起止与时区未知；非月搜索量、非本店SKU漏斗、count不可跨词累加",
        "metricSemantics": {
            "itemsViews": "展示商品数量（shown_items_count），不是商品浏览量或平均浏览商品数",
            "ord": "下单独立买家，不是订单数或商品件数",
            "gmv": "按查询归因的订购金额，不是结算收入",
            "avgCaRub": "市场平均价格RUB，不是CPC或本店可实现成交价",
        },
        "dataQualitySemantics": {
            "NUMERIC_FULL_4D_ONLY": "仅表示四维评分输入数值完整，不代表身份、合规或商业PASS",
        },
        "hash": input_hash,
        "companyId": "REDACTED" if "companyId" in source_metadata else None,
        "source": {
            "inputFileName": input_path.name,
            "inputSha256": input_hash,
            "sourceMetadata": safe_source_metadata(source_metadata),
            "sourceMetadataPath": str(Path(args.meta).resolve()) if args.meta else None,
            "declaredInputFileHashes": json_safe(declared_input_hashes),
            "declaredHashMatchesInput": hash_match,
            "sourceContentSha256": json_safe(content_sha256),
            "sourceContentSha256Comparison": (
                "NOT_COMPARABLE_DIFFERENT_SERIALIZATION" if content_sha256 is not None else None
            ),
            "expectationChecks": {
                "expectedRows": expected_rows,
                "actualRows": raw_rows,
                "expectedUniqueQueries": expected_unique,
                "actualUniqueQueries": len(dedup),
            },
        },
        "filterFunnel": funnel,
        "quantileScopes": {
            "quantiles": "清洗并精确去重后、治理过滤前的完整有效唯一词分布，用于对照原始真实分布基准",
            "eligibleQuantiles": "治理过滤后进入四象限明细的候选分布，不用于替代完整批次分布",
        },
        "quantiles": full_quantiles,
        "eligibleQuantiles": quantile_snapshot(enriched),
        "parameters": {
            "fixedWeights": dict(FIXED_WEIGHTS),
            "minimumActiveWeight": MIN_ACTIVE_WEIGHT,
            "thresholds": config.thresholds,
            "quadrantPriority": list(QUADRANT_PRIORITY) + [REGULAR_QUADRANT],
            "top30CommercialIntentGate": {
                "caMinPct": config.thresholds["ca_viable_floor_pct"],
                "searchUsersToOrdUsersMinPct": config.thresholds["top30_min_search_to_ord_pct"],
                "missingPolicy": "EXCLUDE_WITHOUT_ZERO_IMPUTATION",
            },
            "top30Rule": (
                "仅专项象限+有效评分+"
                f"{config.thresholds['avg_price_fbs_viable_floor_rub']:g}.."
                f"{config.thresholds['avg_price_cross_border_safe_max_rub']:g}RUB价格带+"
                "无高无交互0单/超大词/极端价等风险+"
                f"ca>={config.thresholds['ca_viable_floor_pct']:g}%+"
                "searchUsersToOrdUsers>="
                f"{config.thresholds['top30_min_search_to_ord_pct']:g}%（缺失不补0）+"
                "无AMBIGUOUS_IDENTITY/BRAND_REVIEW_REQUIRED人工复核阻断；不足不补"
            ),
        },
        "scaling": scaling,
        "schemaAudit": schema_audit,
        "governance": {
            "blacklistPath": config.blacklist_path,
            "centralConfigPath": config.governance_config_path,
            "localConfigPath": config.config_path,
            "centralRuleCategoriesReused": [
                "terminatedDirections", "existingPortfolioExclusions", "nonPurchaseNoiseTokens", "brandWatchTokens",
            ],
            "auditSheet": "品牌词过滤记录（同时承载品牌、既有、终止与非购买噪音审计）",
            "nonPurchaseNoiseAdapter": {
                "ambiguousBareTokensNotAutoFiltered": ["фото", "видео", "ремонт"],
                "singleTokenMode": "LITERAL_WHOLE_WORD",
                "multiTokenMode": "STEM_COMBINATION",
                "note": "歧义裸词不自动隔离；中央配置不变",
            },
        },
        "wordstat": wordstat_meta,
        "translationOverrides": {
            "path": str(Path(args.translation_overrides).resolve()) if args.translation_overrides else None,
            "reviewStatus": "ALL_TEXT_REMAINS_待审草稿_FOR_KIMI_REVIEW",
            "manualReviewFlagField": "manual_review_flags",
            "supportedReviewFlagInput": "数组或|分隔字符串",
            "top30BlockingReviewFlags": sorted(MANUAL_REVIEW_TOP30_BLOCKERS),
            "blockingReason": "MANUAL_IDENTITY_REVIEW",
        },
        "economics": {
            "model": "国内跨境FBS/rFBS真实成本待核",
            "testableNetMarginMinimum": 0.10,
            "preferredNetMarginMinimum": 0.15,
            "numericCostCapsCalculated": False,
            "reason": "1688实价/国内运费/包装/实测克重尺寸/实际仓线/佣金/退货/支付/CPS未齐，不用占位费率输出伪精确上限",
            "pendingInputs": PENDING_ECONOMICS_INPUTS,
            "contentRequirement": "完整8图+双视频+独立复核",
        },
        "governanceBoundaries": GOVERNANCE_BOUNDARIES,
        "reproduceArgv": command_argv,
        "reproduceCommand": subprocess.list2cmdline(command_argv),
    }
    outputs = export_excel_and_markdown_reports(
        args.output_dir, enriched, top30, filtered, quarantine, manifest
    )
    return {"manifest": manifest, "outputs": outputs, "top30": top30, "detail": enriched}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Ozon Seller days_7 搜索查询离线只读分析；不访问网络或生产数据"
    )
    parser.add_argument("--input", required=True, help="输入.xlsx或.csv")
    parser.add_argument("--meta", help="可选source metadata JSON")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="本地校准阈值与补充治理YAML")
    parser.add_argument("--blacklist", default=str(DEFAULT_BLACKLIST), help="本地品牌/IP黑名单txt")
    parser.add_argument(
        "--governance-config", default=str(DEFAULT_GOVERNANCE_CONFIG), help="中央governanceRules YAML"
    )
    parser.add_argument(
        "--translation-overrides", default=str(DEFAULT_TRANSLATION_OVERRIDES),
        help="通用查询审阅YAML；默认review-overrides.yaml，显式参数可覆盖，输出仍为待审草稿",
    )
    parser.add_argument("--wordstat-receipt", help="可选真实Wordstat receipt JSON；只读，不请求网络")
    parser.add_argument("--output-dir", default=str(BASE_DIR / "output"), help="报告输出目录")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = run_analysis(args)
    except AnalyzerInputError as exc:
        print(f"输入/配置错误（退出码2）：{exc}", file=sys.stderr)
        return 2
    manifest = result["manifest"]
    print(
        f"离线分析完成：原始{manifest['filterFunnel']['rawRows']}行，"
        f"明细{manifest['filterFunnel']['eligibleRows']}行，Top30实际{manifest['filterFunnel']['top30Actual']}行。"
    )
    print("所有结果均为待核假设，非生产或经营动作授权。")
    print(f"一键复现：{manifest['reproduceCommand']}")
    for name, path in result["outputs"].items():
        print(f"{name}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
