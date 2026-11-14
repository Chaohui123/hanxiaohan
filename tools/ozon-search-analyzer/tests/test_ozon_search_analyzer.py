import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from openpyxl import Workbook, load_workbook

import ozon_search_analyzer as analyzer


FULL_METRICS = {
    "count": 10000,
    "uniqQueriesWCa": 120,
    "ca": 40,
    "ord": 350,
    "searchUsersToOrdUsers": 12,
    "gmv": 900000,
    "avgCaRub": 3000,
    "itemsViews": 8,
    "uniqSellers": 10,
    "usersWithoutInterectionCount": 50,
    "usersWithoutInterectionShare": 50,
    "zrCount": 3,
    "zrShare": 2.5,
    "dynamic7": None,
    "dynamic28": None,
}


def make_row(query="органайзер для хранения", **changes):
    row = {"query": query, **FULL_METRICS}
    row.update(changes)
    return row


@pytest.fixture
def offline_paths(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("profile: days_7_calibrated\n", encoding="utf-8")
    blacklist = tmp_path / "blacklist.txt"
    blacklist.write_text("", encoding="utf-8")
    governance = tmp_path / "governance.yaml"
    governance.write_text("governanceRules: {}\n", encoding="utf-8")
    return {"config": config, "blacklist": blacklist, "governance": governance}


def runtime_config(paths):
    return analyzer.load_runtime_config(
        paths["config"], paths["blacklist"], paths["governance"]
    )


def cli_args(input_path, output_dir, paths, **optional):
    args = [
        "--input", str(input_path),
        "--config", str(paths["config"]),
        "--blacklist", str(paths["blacklist"]),
        "--governance-config", str(paths["governance"]),
        "--output-dir", str(output_dir),
    ]
    for key, value in optional.items():
        args.extend([f"--{key.replace('_', '-')}", str(value)])
    return args


def analyze_frame(frame, config):
    valid, invalid = analyzer.clean_validate_and_quarantine(frame, config)
    dedup, duplicates = analyzer.deduplicate_and_cluster_queries(valid)
    eligible, filtered = analyzer.apply_blacklist_and_shop_direction_guards(dedup, config)
    eligible = analyzer.add_price_observation(eligible)
    scored = analyzer.compute_robust_opportunity_scores(eligible, config)
    return analyzer.classify_four_quadrants(scored, config), invalid, duplicates, filtered


def prepare_mapped(frame):
    mapped = frame.copy()
    for field in analyzer.ALL_FIELDS:
        if field not in mapped:
            mapped[field] = np.nan
    mapped.insert(0, "original_row_id", np.arange(2, len(mapped) + 2))
    return mapped[list(["original_row_id", *analyzer.ALL_FIELDS])]


def test_empty_csv_and_xlsx_generate_empty_reports(tmp_path, offline_paths):
    for suffix in ("csv", "xlsx"):
        input_path = tmp_path / f"empty.{suffix}"
        if suffix == "csv":
            input_path.write_text("query,count,ca\n", encoding="utf-8")
        else:
            pd.DataFrame(columns=["query", "count", "ca"]).to_excel(input_path, index=False)
        output = tmp_path / f"out-{suffix}"
        assert analyzer.main(cli_args(input_path, output, offline_paths)) == 0
        assert {path.name for path in output.iterdir()} == {
            "ozon_selection_report.xlsx", "ozon_selection_brief.md", "run_manifest.json"
        }
        manifest = json.loads((output / "run_manifest.json").read_text(encoding="utf-8"))
        assert manifest["filterFunnel"]["rawRows"] == 0
        assert manifest["filterFunnel"]["top30Actual"] == 0
        workbook = load_workbook(output / "ozon_selection_report.xlsx")
        assert workbook.sheetnames == [
            "00_批次口径与回执元数据", "Top30_立项推荐", "四象限分类明细",
            "品牌词过滤记录", "不合格与异常隔离",
        ]
        assert workbook["Top30_立项推荐"].max_row == 2
        assert "Top 0" in (output / "ozon_selection_brief.md").read_text(encoding="utf-8")


def test_missing_columns_and_completely_headerless_exit_2(tmp_path, offline_paths, capsys):
    missing = tmp_path / "missing.csv"
    missing.write_text("query,ca\n词,20\n", encoding="utf-8")
    assert analyzer.main(cli_args(missing, tmp_path / "out1", offline_paths)) == 2
    assert "count" in capsys.readouterr().err
    blank = tmp_path / "blank.csv"
    blank.write_text("", encoding="utf-8")
    assert analyzer.main(cli_args(blank, tmp_path / "out2", offline_paths)) == 2
    assert "无合法表头" in capsys.readouterr().err


def test_native_russian_and_chinese_headers_map_identically(tmp_path, offline_paths):
    rows = [
        make_row("органайзер для хранения"),
        make_row("наматрасник непромокаемый", count=7000, ca=20, ord=130,
                 searchUsersToOrdUsers=5, usersWithoutInterectionShare=30, uniqSellers=30),
    ]
    native = pd.DataFrame(rows)
    variants = {"native": list(native.columns)}
    for language in ("russian", "chinese"):
        names = []
        for column in native.columns:
            aliases = analyzer.SCHEMA_ALIASES[column]
            names.append(aliases[-1] if language == "chinese" else aliases[1])
        variants[language] = names
    outputs = {}
    for language, columns in variants.items():
        path = tmp_path / f"{language}.csv"
        native.copy().set_axis(columns, axis=1).to_csv(path, index=False)
        mapped, audit = analyzer.read_and_map_seller_queries(path)
        assert not audit["percentageConversions"]
        assert [float(value) for value in mapped["ca"]] == [40, 20]
        tagged, invalid, _, _ = analyze_frame(mapped, runtime_config(offline_paths))
        assert invalid.empty
        outputs[language] = tagged
    for column in ("count", "ca", "avgCaRub", "Opportunity_Score", "primary_quadrant"):
        assert outputs["native"][column].tolist() == outputs["russian"][column].tolist()
        assert outputs["native"][column].tolist() == outputs["chinese"][column].tolist()


def test_conflicting_alias_columns_fail_explicitly(tmp_path):
    path = tmp_path / "conflict.csv"
    path.write_text("query,count,ca,加购转化率\n词,5000,20,30\n", encoding="utf-8")
    with pytest.raises(analyzer.AnalyzerInputError, match="多列映射冲突.*ca"):
        analyzer.read_and_map_seller_queries(path)


def test_xlsx_percent_format_only_converts_explicit_zero_to_one_cells(tmp_path):
    path = tmp_path / "percent.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["query", "count", "ca", "usersWithoutInterectionShare"])
    sheet.append(["词一", 5000, 0.2408, 24.08])
    sheet.append(["词二", 6000, 24.08, 0.5])
    sheet["C2"].number_format = "0.00%"
    sheet["D2"].number_format = '0.00"%"'
    sheet["C3"].number_format = "General"
    sheet["D3"].number_format = "0.00%"
    workbook.save(path)
    mapped, audit = analyzer.read_and_map_seller_queries(path)
    assert mapped["ca"].tolist() == [24.08, 24.08]
    assert mapped["usersWithoutInterectionShare"].tolist() == [24.08, 50.0]
    assert len(audit["percentageConversions"]) == 2
    assert {item["field"] for item in audit["percentageConversions"]} == {
        "ca", "usersWithoutInterectionShare"
    }


def test_null_true_zero_and_unobserved_price_remain_distinct(offline_paths):
    frame = prepare_mapped(pd.DataFrame([
        make_row("нулевой", uniqQueriesWCa=0, ca=0, ord=0, avgCaRub=0),
        make_row("пропуск", uniqQueriesWCa=120, ca=15, ord=10, avgCaRub=None, dynamic7=None),
        make_row("неполный", count=8000, ca=None, avgCaRub=None,
                 usersWithoutInterectionShare=None),
    ]))
    valid, quarantine = analyzer.clean_validate_and_quarantine(frame, runtime_config(offline_paths))
    assert quarantine.empty
    valid = analyzer.add_price_observation(valid)
    scored = analyzer.compute_robust_opportunity_scores(valid, runtime_config(offline_paths))
    assert scored.loc[0, "avgCaRub"] == 0
    assert math.isnan(scored.loc[0, "avgCaRub_effective"])
    assert scored.loc[0, "price_obs_status"] == "UNOBSERVED_NO_CART"
    assert scored.loc[0, "ca"] == 0 and scored.loc[0, "S_ca"] == 0
    assert scored.loc[0, "active_weight_sum"] == 0.9
    assert scored.loc[0, "score_status"] == "PARTIAL_RENORMALIZED"
    assert math.isnan(scored.loc[1, "dynamic7"])
    assert math.isnan(scored.loc[1, "avgCaRub_effective"])
    assert scored.loc[2, "active_weight_sum"] == 0.3
    assert math.isnan(scored.loc[2, "Opportunity_Score"])
    assert scored.loc[2, "score_status"] == "INSUFFICIENT_METRICS"


def test_non_numeric_negative_and_ratio_outliers_are_quarantined(offline_paths):
    frame = prepare_mapped(pd.DataFrame([
        make_row("плохое число", ca="abc"),
        make_row("отрицание", gmv=-1),
        make_row("процент", ca=100.01),
        make_row("", count=5000),
        make_row("ноль", count=0),
        make_row("хорошо"),
    ]))
    valid, quarantine = analyzer.clean_validate_and_quarantine(frame, runtime_config(offline_paths))
    assert valid["query"].tolist() == ["хорошо"]
    assert len(quarantine) == 5
    assert set(quarantine["isolation_type"]) == {
        "NON_NUMERIC_METRIC", "NEGATIVE_METRIC", "RATIO_OUT_OF_BOUNDS",
        "EMPTY_QUERY", "NON_POSITIVE_COUNT",
    }


def test_brand_existing_terminated_and_noise_rules_cover_inflections(tmp_path):
    blacklist = tmp_path / "brand.txt"
    blacklist.write_text("apple\n", encoding="utf-8")
    config = analyzer.load_runtime_config(
        analyzer.DEFAULT_CONFIG, blacklist, analyzer.DEFAULT_GOVERNANCE_CONFIG
    )
    queries = [
        "Apple",
        "TPMS Chery",
        "датчики давления в шинах",
        "ремня вариатора буран",
        "подогрев боковых зеркал",
        "зеркала нагревательный элемент",
        "зимнее термобельё для женщин",
        "органайзер своими руками",
        "руками своими органайзер",
        "ИКЕА",
        "безопасный органайзер",
    ]
    frame = prepare_mapped(pd.DataFrame([make_row(query) for query in queries]))
    valid, _ = analyzer.clean_validate_and_quarantine(frame, config)
    dedup, _ = analyzer.deduplicate_and_cluster_queries(valid)
    eligible, filtered = analyzer.apply_blacklist_and_shop_direction_guards(dedup, config)
    assert eligible["query"].tolist() == ["безопасный органайзер"]
    assert len(filtered) == 10
    by_query = filtered.set_index("query")
    assert by_query.loc["Apple", "filter_category"] == "BRAND_IP_BLACKLIST"
    assert by_query.loc["TPMS Chery", "filter_category"] == "SHOP_EXISTING_SKU"
    assert by_query.loc["ремня вариатора буран", "filter_category"] == "SHOP_EXISTING_SKU"
    assert by_query.loc["подогрев боковых зеркал", "filter_category"] == "SHOP_TERMINATED_DIRECTION"
    assert by_query.loc["зимнее термобельё для женщин", "filter_category"] == "SHOP_TERMINATED_DIRECTION"
    assert by_query.loc["органайзер своими руками", "filter_category"] == "NON_PURCHASE_NOISE"
    assert by_query.loc["руками своими органайзер", "filter_category"] == "NON_PURCHASE_NOISE"
    assert by_query.loc["ИКЕА", "filter_category"] == "BRAND_IP_BLACKLIST"
    assert filtered["governance_audit_json"].str.len().gt(2).all()


def test_exact_duplicates_keep_most_complete_without_summing_and_clusters_do_not_merge(offline_paths):
    frame = prepare_mapped(pd.DataFrame([
        make_row("Аэрогриль  ", count=224772, ca=None),
        make_row("аэрогриль", count=224772, ca=20),
        make_row("куртка зимняя женская", count=359872),
        make_row("куртка женская зимняя", count=85000),
    ]))
    valid, _ = analyzer.clean_validate_and_quarantine(frame, runtime_config(offline_paths))
    dedup, duplicates = analyzer.deduplicate_and_cluster_queries(valid)
    grill = dedup.loc[dedup["query_norm"] == "аэрогриль"].iloc[0]
    assert grill["count"] == 224772
    assert grill["original_row_id"] == 3
    assert grill["ca"] == 20
    duplicate = duplicates.loc[duplicates["query_norm"] == "аэрогриль"].iloc[0]
    assert duplicate["kept_master_row_id"] == 3
    coats = dedup.loc[dedup["query_norm"].str.startswith("куртка")]
    assert len(coats) == 2
    assert coats["token_cluster_id"].nunique() == 1
    assert coats["count"].tolist() == [359872, 85000]


def test_fixed_weight_known_vector_and_config_lock(tmp_path, offline_paths):
    score, active, status = analyzer.combine_opportunity_score(0.8, 0.6, 0.4, 0.5)
    assert score == 60.0
    assert active == 1.0
    assert status == "FULL_4D_RANKING_ONLY"
    partial, active, status = analyzer.combine_opportunity_score(0.8, 0.6, 0.4, np.nan)
    assert partial == pytest.approx(61.11)
    assert active == 0.9
    assert status == "PARTIAL_RENORMALIZED"
    boundary, active, status = analyzer.combine_opportunity_score(0.8, 0.6, np.nan, np.nan)
    assert boundary == pytest.approx(69.23)
    assert active == 0.65
    assert status == "PARTIAL_RENORMALIZED"
    bad = tmp_path / "weights.yaml"
    bad.write_text("scoring:\n  weights:\n    heat: 0.9\n", encoding="utf-8")
    with pytest.raises(analyzer.AnalyzerInputError, match="权重"):
        analyzer.load_runtime_config(bad, offline_paths["blacklist"], offline_paths["governance"])


def test_multi_quadrant_hits_and_primary_priority(offline_paths):
    tagged, _, _, _ = analyze_frame(prepare_mapped(pd.DataFrame([make_row()])), runtime_config(offline_paths))
    row = tagged.iloc[0]
    assert row["all_matched_quadrants"] == "蓝海缺口|高转化刚需|高客单垂类"
    assert row["primary_quadrant"] == "蓝海缺口"
    assert "非授权" in row["quadrant_hypothesis_note"]


def test_extreme_price_and_broad_head_never_enter_top30(offline_paths):
    rows = [
        make_row("обычная цена", avgCaRub=1500),
        make_row("средняя цена", avgCaRub=2500),
        make_row("выше цена", avgCaRub=5992),
        make_row("экстрим", avgCaRub=89316390),
        make_row("огромный запрос", count=50001),
    ]
    tagged, _, _, _ = analyze_frame(prepare_mapped(pd.DataFrame(rows)), runtime_config(offline_paths))
    normal = tagged.set_index("query")
    assert normal.loc["обычная цена", "S_price"] < normal.loc["средняя цена", "S_price"]
    assert normal.loc["средняя цена", "S_price"] < normal.loc["выше цена", "S_price"]
    assert "WARN_EXTREME_PRICE_OUTLIER" in normal.loc["экстрим", "data_quality_status"]
    enriched = analyzer.calculate_reverse_fbs_hurdles(
        analyzer.generate_links_and_draft_placeholders(tagged)
    )
    top = analyzer.select_top30(enriched)
    assert "экстрим" not in top["query"].tolist()
    assert "огромный запрос" not in top["query"].tolist()


def test_formula_injection_hyperlinks_percent_and_null_rendering(tmp_path, offline_paths):
    input_path = tmp_path / "formula.csv"
    pd.DataFrame([make_row("=1+1")]).to_csv(input_path, index=False)
    output = tmp_path / "report"
    assert analyzer.main(cli_args(input_path, output, offline_paths)) == 0
    workbook = load_workbook(output / "ozon_selection_report.xlsx")
    top = workbook["Top30_立项推荐"]
    headers = {cell.value: cell.column for cell in top[2]}
    query_cell = top.cell(3, headers["query"])
    assert query_cell.value == "'=1+1"
    assert query_cell.data_type != "f"
    ca_cell = top.cell(3, headers["ca"])
    assert ca_cell.value == 40
    assert ca_cell.number_format == '0.00"%"'
    ozon_cell = top.cell(3, headers["ozon_search_url"])
    assert ozon_cell.value == "Ozon调研"
    assert ozon_cell.hyperlink.target.startswith("https://www.ozon.ru/search/?text=%3D1%2B1")
    assert top.freeze_panes == "A3"
    assert top.auto_filter.ref.startswith("A2:")
    detail = workbook["四象限分类明细"]
    detail_headers = {cell.value: cell.column for cell in detail[1]}
    assert detail.cell(2, detail_headers["dynamic7"]).value == "N/A"
    manifest = json.loads((output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["filterFunnel"]["top30Actual"] == 1
    assert manifest["filterFunnel"]["markdownTop10Actual"] == 1
    assert "Top 1" in (output / "ozon_selection_brief.md").read_text(encoding="utf-8")
    assert "reproduceCommand" in manifest


def test_no_padding_when_no_special_candidate(tmp_path, offline_paths):
    input_path = tmp_path / "regular.csv"
    pd.DataFrame([make_row("обычный запрос", count=1000, ca=5, ord=1)]).to_csv(input_path, index=False)
    output = tmp_path / "report"
    assert analyzer.main(cli_args(input_path, output, offline_paths)) == 0
    workbook = load_workbook(output / "ozon_selection_report.xlsx")
    assert workbook["Top30_立项推荐"].max_row == 2
    brief = (output / "ozon_selection_brief.md").read_text(encoding="utf-8")
    assert "Top 0" in brief
    assert "不以常规词或过滤词凑数" in brief


def test_wordstat_not_requested_missing_uncertain_valid_zero(tmp_path):
    frame = pd.DataFrame({"query": ["валидный", "неизвестный", "отсутствует"]})
    no_receipt, meta = analyzer.attach_wordstat_cross_check(frame)
    assert no_receipt["ws_status"].tolist() == ["NOT_REQUESTED"] * 3
    assert no_receipt["ws_count"].isna().all()
    assert meta["status"] == "NOT_REQUESTED"
    receipt = tmp_path / "receipt.json"
    receipt.write_text(json.dumps({
        "sourceAsOf": "2026-11-14T00:00:00Z",
        "periodWindow": {"start": "2026-10-01", "end": "2026-10-07"},
        "receiptSha256": "declared-hash",
        "records": [
            {"query": "валидный", "status": "SUCCESS", "totalCount": 0},
            {"query": "неизвестный", "status": "TIMEOUT", "totalCount": 999},
        ],
    }, ensure_ascii=False), encoding="utf-8")
    result, meta = analyzer.attach_wordstat_cross_check(frame, receipt)
    assert result["ws_status"].tolist() == ["VALID", "UNCERTAIN", "MISSING"]
    assert result.loc[0, "ws_count"] == 0
    assert result.loc[1:, "ws_count"].isna().all()
    assert result["ws_sourceAsOf"].eq("2026-11-14T00:00:00Z").all()
    assert meta["receiptSha256"] == "declared-hash"
    assert len(meta["receiptFileSha256"]) == 64


def test_malformed_wordstat_receipt_is_uncertain_not_zero(tmp_path):
    receipt = tmp_path / "broken.json"
    receipt.write_text("not-json", encoding="utf-8")
    result, meta = analyzer.attach_wordstat_cross_check(pd.DataFrame({"query": ["词"]}), receipt)
    assert result["ws_status"].tolist() == ["UNCERTAIN"]
    assert result["ws_count"].isna().all()
    assert meta["error"]


def test_translation_overrides_remain_draft_and_urls_use_quote_plus():
    frame = pd.DataFrame({"query": ["пакеты для одежды"]})
    result = analyzer.generate_links_and_draft_placeholders(
        frame, {"queries": {"пакеты для одежды": {"cn_gloss": "衣物收纳袋", "form": "待核形态"}}}
    )
    row = result.iloc[0]
    assert row["cn_gloss_draft"] == "[待审草稿] 衣物收纳袋"
    assert row["form_hypothesis_draft"] == "[待审草稿] 待核形态"
    assert "+%D0%B4%D0%BB%D1%8F+" in row["ozon_search_url"]
    assert quote_plus_in_url(row["yandex_search_url"])
    assert quote_plus_in_url(row["wordstat_url"])
    assert "季节窗口与跨境妥投周期待核" in row["mandatory_pending_actions"]


def quote_plus_in_url(url):
    return "%D0%BF%D0%B0%D0%BA%D0%B5%D1%82%D1%8B+%D0%B4%D0%BB%D1%8F" in url


def test_economics_never_outputs_placeholder_cost_caps(offline_paths):
    tagged, _, _, _ = analyze_frame(prepare_mapped(pd.DataFrame([make_row()])), runtime_config(offline_paths))
    result = analyzer.calculate_reverse_fbs_hurdles(tagged)
    row = result.iloc[0]
    assert math.isnan(row["max_total_cost_rub_10pct"])
    assert math.isnan(row["max_total_cost_rub_15pct"])
    assert row["economics_gate_status"] == "PENDING_REAL_COSTS_NO_NUMERIC_CAP"
    for item in ("1688实价", "国内运费", "包装", "实测克重", "实际FBS/rFBS仓线", "佣金", "退货", "支付", "CPS"):
        assert item in row["economics_pending_inputs"]
    assert row["content_gate_status"] == "PENDING_8_IMAGES_AND_2_VIDEOS"


def test_no_interaction_upper_anchor_never_exceeds_85(offline_paths):
    frame = prepare_mapped(pd.DataFrame([
        make_row("低", usersWithoutInterectionShare=10),
        make_row("中", usersWithoutInterectionShare=85),
        make_row("高", usersWithoutInterectionShare=100),
    ]))
    scored = analyzer.compute_robust_opportunity_scores(
        analyzer.add_price_observation(frame), runtime_config(offline_paths)
    )
    assert scored.attrs["scaling"]["no_int"]["upperAnchor"] <= 85
    assert scored.loc[2, "S_no_int"] == 1


def test_single_value_and_empty_scoring_are_stable(offline_paths):
    config = runtime_config(offline_paths)
    single = analyzer.compute_robust_opportunity_scores(
        analyzer.add_price_observation(prepare_mapped(pd.DataFrame([make_row()]))), config
    )
    assert single.loc[0, ["S_heat", "S_no_int", "S_ca", "S_price"]].tolist() == [0.5] * 4
    assert single.loc[0, "Opportunity_Score"] == 50.0
    empty = analyzer.compute_robust_opportunity_scores(
        analyzer.add_price_observation(prepare_mapped(pd.DataFrame(columns=analyzer.ALL_FIELDS))), config
    )
    assert empty.empty
    assert empty["Opportunity_Score"].isna().all()


def test_source_metadata_redacts_company_and_rejects_other_period(tmp_path, offline_paths):
    input_path = tmp_path / "input.csv"
    pd.DataFrame([make_row()]).to_csv(input_path, index=False)
    meta = tmp_path / "meta.json"
    meta.write_text(json.dumps({
        "runId": "fixture-run", "anchorAt": "2026-11-14T00:00:00Z",
        "nativePeriod": "days_7", "companyId": "123456", "internalSecret": "do-not-copy"
    }), encoding="utf-8")
    output = tmp_path / "out"
    assert analyzer.main(cli_args(input_path, output, offline_paths, meta=meta)) == 0
    manifest = json.loads((output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["runId"] == "fixture-run"
    assert manifest["companyId"] == "REDACTED"
    assert "123456" not in json.dumps(manifest, ensure_ascii=False)
    assert "internalSecret" not in manifest["source"]["sourceMetadata"]
    assert manifest["nativePeriod"] == "days_7"
    meta.write_text(json.dumps({"nativePeriod": "days_28"}), encoding="utf-8")
    assert analyzer.main(cli_args(input_path, tmp_path / "out2", offline_paths, meta=meta)) == 2


def test_quantiles_are_pre_governance_dedup_and_eligible_is_separate(tmp_path, offline_paths):
    offline_paths["blacklist"].write_text("apple\n", encoding="utf-8")
    input_path = tmp_path / "quantiles.csv"
    pd.DataFrame([
        make_row("alpha", count=1000),
        make_row("beta", count=2000),
        make_row("Apple", count=9000),
        make_row(" alpha ", count=1000),
        make_row("broken", count=None),
    ]).to_csv(input_path, index=False)
    meta = tmp_path / "quantiles-meta.json"
    meta.write_text(json.dumps({
        "nativePeriod": "days_7", "expectedRows": 5, "expectedUniqueQueries": 3
    }), encoding="utf-8")
    output = tmp_path / "quantiles-out"
    assert analyzer.main(cli_args(input_path, output, offline_paths, meta=meta)) == 0
    manifest = json.loads((output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["quantiles"]["count"]["present"] == 3
    assert manifest["quantiles"]["count"]["p50"] == 2000
    assert manifest["eligibleQuantiles"]["count"]["present"] == 2
    assert manifest["eligibleQuantiles"]["count"]["p50"] == 1500
    assert "治理过滤前" in manifest["quantileScopes"]["quantiles"]
    assert "治理过滤后" in manifest["quantileScopes"]["eligibleQuantiles"]
    brief = (output / "ozon_selection_brief.md").read_text(encoding="utf-8")
    assert "`quantiles`" in brief and "`eligibleQuantiles`" in brief
    assert "count P50=2,000.00" in brief
    workbook = load_workbook(output / "ozon_selection_report.xlsx")
    metadata = {
        row[1]: row[2]
        for row in workbook["00_批次口径与回执元数据"].iter_rows(min_row=3, values_only=True)
    }
    assert metadata["quantiles.count.p50"] == 2000
    assert metadata["eligibleQuantiles.count.p50"] == 1500
    assert "治理过滤前" in metadata["quantileScopes.quantiles"]
    assert "治理过滤后" in metadata["quantileScopes.eligibleQuantiles"]


def test_content_hash_is_not_file_hash_and_explicit_input_hash_is_compared(tmp_path, offline_paths):
    input_path = tmp_path / "hash.csv"
    pd.DataFrame([make_row()]).to_csv(input_path, index=False)
    meta = tmp_path / "hash-meta.json"
    content = {
        "nativePeriod": "days_7", "contentSha256": "normalized-content-sha256",
        "sha256": "ambiguous-not-an-input-file-hash", "hash": "also-ambiguous",
        "inputFileSha256": None,
    }
    meta.write_text(json.dumps(content), encoding="utf-8")
    original_metadata = meta.read_bytes()
    content_output = tmp_path / "content-out"
    assert analyzer.main(cli_args(input_path, content_output, offline_paths, meta=meta)) == 0
    assert meta.read_bytes() == original_metadata
    manifest = json.loads((content_output / "run_manifest.json").read_text(encoding="utf-8"))
    source = manifest["source"]
    assert source["declaredHashMatchesInput"] is None
    assert source["sourceContentSha256"] == "normalized-content-sha256"
    assert source["sourceContentSha256Comparison"] == "NOT_COMPARABLE_DIFFERENT_SERIALIZATION"
    assert source["sourceMetadata"]["sourceContentSha256"] == "normalized-content-sha256"
    assert "contentSha256" not in source["declaredInputFileHashes"]

    content["inputFileSha256"] = analyzer.sha256_file(input_path)
    meta.write_text(json.dumps(content), encoding="utf-8")
    matching_output = tmp_path / "matching-out"
    assert analyzer.main(cli_args(input_path, matching_output, offline_paths, meta=meta)) == 0
    manifest = json.loads((matching_output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["source"]["declaredHashMatchesInput"] is True

    content.pop("inputFileSha256")
    content["inputSha256"] = "0" * 64
    meta.write_text(json.dumps(content), encoding="utf-8")
    mismatch_output = tmp_path / "mismatch-out"
    assert analyzer.main(cli_args(input_path, mismatch_output, offline_paths, meta=meta)) == 0
    manifest = json.loads((mismatch_output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["source"]["declaredHashMatchesInput"] is False


def test_expected_rows_mismatch_rejects_partial_input(tmp_path, offline_paths, capsys):
    input_path = tmp_path / "partial.csv"
    pd.DataFrame([make_row("一"), make_row("二")]).to_csv(input_path, index=False)
    meta = tmp_path / "partial-meta.json"
    meta.write_text(json.dumps({"expectedRows": 3}), encoding="utf-8")
    output = tmp_path / "partial-out"
    assert analyzer.main(cli_args(input_path, output, offline_paths, meta=meta)) == 2
    error = capsys.readouterr().err
    assert "expectedRows不一致" in error
    assert "metadata=3" in error and "实际读取=2" in error
    assert not output.exists()


def test_expected_unique_queries_mismatch_rejects_duplicate_batch(tmp_path, offline_paths, capsys):
    input_path = tmp_path / "unique.csv"
    pd.DataFrame([make_row("Аэрогриль"), make_row(" аэрогриль ")]).to_csv(input_path, index=False)
    meta = tmp_path / "unique-meta.json"
    meta.write_text(json.dumps({"expectedRows": 2, "expectedUniqueQueries": 2}), encoding="utf-8")
    output = tmp_path / "unique-out"
    assert analyzer.main(cli_args(input_path, output, offline_paths, meta=meta)) == 2
    error = capsys.readouterr().err
    assert "expectedUniqueQueries不一致" in error
    assert "metadata=2" in error and "精确去重后=1" in error
    assert not output.exists()


def test_missing_count_is_quarantined_but_non_numeric_count_stays_distinct(offline_paths):
    frame = prepare_mapped(pd.DataFrame([
        make_row("空值", count=None),
        make_row("空字符串", count=""),
        make_row("非数值", count="abc"),
        make_row("有效"),
    ]))
    valid, quarantine = analyzer.clean_validate_and_quarantine(frame, runtime_config(offline_paths))
    assert valid["query"].tolist() == ["有效"]
    by_query = quarantine.set_index("raw_query")
    assert by_query.loc["空值", "isolation_type"] == "MISSING_COUNT"
    assert by_query.loc["空字符串", "isolation_type"] == "MISSING_COUNT"
    assert by_query.loc["非数值", "isolation_type"] == "NON_NUMERIC_METRIC"
    assert "MISSING_COUNT" not in by_query.loc["非数值", "isolation_type"]


def test_top30_commercial_intent_gate_excludes_generic_terms_and_exports_audit(tmp_path, offline_paths):
    input_path = tmp_path / "commercial-intent.csv"
    pd.DataFrame([
        make_row("пальто", ca=4.66, searchUsersToOrdUsers=0.76,
                 usersWithoutInterectionShare=80),
        make_row("обувь", ca=20, searchUsersToOrdUsers=1.99,
                 usersWithoutInterectionShare=80),
        make_row("органайзер для хранения", usersWithoutInterectionShare=50),
    ]).to_csv(input_path, index=False)
    output = tmp_path / "commercial-intent-out"
    assert analyzer.main(cli_args(input_path, output, offline_paths)) == 0
    workbook = load_workbook(output / "ozon_selection_report.xlsx")
    top = workbook["Top30_立项推荐"]
    top_headers = {cell.value: cell.column for cell in top[2]}
    assert top.max_row == 3
    assert top.cell(3, top_headers["query"]).value == "органайзер для хранения"
    detail = workbook["四象限分类明细"]
    headers = {cell.value: cell.column for cell in detail[1]}
    detail_rows = {}
    for row_index in range(2, detail.max_row + 1):
        query = detail.cell(row_index, headers["query"]).value
        detail_rows[query] = {
            column: detail.cell(row_index, column_index).value
            for column, column_index in headers.items()
        }
    assert detail_rows["пальто"]["primary_quadrant"] == "蓝海缺口"
    assert detail_rows["обувь"]["primary_quadrant"] == "蓝海缺口"
    assert detail_rows["пальто"]["top30_eligible"] is False
    assert detail_rows["обувь"]["top30_eligible"] is False
    assert detail_rows["пальто"]["top30_exclusion_reason"] == "LOW_COMMERCIAL_INTENT"
    assert detail_rows["обувь"]["top30_exclusion_reason"] == "LOW_COMMERCIAL_INTENT"
    assert detail_rows["органайзер для хранения"]["top30_eligible"] is True
    assert detail_rows["органайзер для хранения"]["top30_exclusion_reason"] == "ELIGIBLE_PENDING_REVIEW"
    manifest = json.loads((output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["filterFunnel"]["rawRows"] == 3
    assert manifest["filterFunnel"]["conservedRows"] == 3
    assert manifest["filterFunnel"]["top30Actual"] == 1
    assert manifest["parameters"]["thresholds"]["top30_min_search_to_ord_pct"] == 2
    gate = manifest["parameters"]["top30CommercialIntentGate"]
    assert gate["caMinPct"] == 15
    assert gate["searchUsersToOrdUsersMinPct"] == 2
    assert gate["missingPolicy"] == "EXCLUDE_WITHOUT_ZERO_IMPUTATION"
    assert "ca>=15%" in manifest["parameters"]["top30Rule"]
    assert "searchUsersToOrdUsers>=2%" in manifest["parameters"]["top30Rule"]
    brief = (output / "ozon_selection_brief.md").read_text(encoding="utf-8")
    assert "ca >= 15%" in brief
    assert "searchUsersToOrdUsers >= 2%" in brief
    assert "高分或高无交互不等于蓝海" in brief


def test_missing_commercial_intent_is_excluded_without_zero_imputation(offline_paths):
    frame = prepare_mapped(pd.DataFrame([
        make_row("缺少加购", ca=None, searchUsersToOrdUsers=12,
                 usersWithoutInterectionShare=70),
        make_row("缺少下单转化", ca=20, searchUsersToOrdUsers=None,
                 usersWithoutInterectionShare=70),
    ]))
    tagged, _, _, _ = analyze_frame(frame, runtime_config(offline_paths))
    assert tagged["primary_quadrant"].tolist() == ["蓝海缺口", "蓝海缺口"]
    enriched = analyzer.calculate_reverse_fbs_hurdles(
        analyzer.generate_links_and_draft_placeholders(tagged), runtime_config(offline_paths)
    )
    audited = analyzer.apply_top30_eligibility(enriched, runtime_config(offline_paths))
    assert audited["top30_eligible"].tolist() == [False, False]
    assert audited["top30_exclusion_reason"].tolist() == [
        "MISSING_COMMERCIAL_INTENT", "MISSING_COMMERCIAL_INTENT"
    ]
    assert math.isnan(audited.loc[0, "ca"])
    assert math.isnan(audited.loc[1, "searchUsersToOrdUsers"])
    assert audited.loc[0, "ca"] != 0
    assert audited.loc[1, "searchUsersToOrdUsers"] != 0
    assert analyzer.select_top30(audited, runtime_config(offline_paths)).empty


def test_ambiguous_bare_noise_tokens_keep_real_product_queries_eligible(tmp_path):
    blacklist = tmp_path / "noise-blacklist.txt"
    blacklist.write_text("", encoding="utf-8")
    config = analyzer.load_runtime_config(
        analyzer.DEFAULT_CONFIG, blacklist, analyzer.DEFAULT_GOVERNANCE_CONFIG
    )
    product_queries = [
        "видеорегистратор",
        "видеокарта",
        "камера видеонаблюдения",
        "фотоаппарат",
        "фотобумага",
        "фоторамка",
        "ремонтные шипы",
        "пленка укрывная для ремонта",
        "рамка для фото",
    ]
    noise_queries = ["органайзер своими руками", "скачать инструкцию", "отзывы о товаре"]
    frame = prepare_mapped(pd.DataFrame([
        make_row(query) for query in product_queries + noise_queries
    ]))
    valid, quarantine = analyzer.clean_validate_and_quarantine(frame, config)
    assert quarantine.empty
    dedup, _ = analyzer.deduplicate_and_cluster_queries(valid)
    eligible, filtered = analyzer.apply_blacklist_and_shop_direction_guards(dedup, config)
    assert eligible["query"].tolist() == product_queries
    assert filtered["query"].tolist() == noise_queries
    assert set(filtered["filter_category"]) == {"NON_PURCHASE_NOISE"}
    patterns = {rule["pattern"] for rule in config.governance_rules["nonPurchaseNoiseTokens"]}
    assert patterns >= {"фото", "видео", "ремонт"}


def test_items_views_fixed_official_russian_and_chinese_headers(tmp_path):
    for header in ("itemsViews", "Количество показанных товаров", "展示商品数量"):
        path = tmp_path / f"items-{len(header)}.csv"
        path.write_text(f"query,count,{header}\nтест,5000,12\n", encoding="utf-8")
        mapped, audit = analyzer.read_and_map_seller_queries(path)
        assert mapped["itemsViews"].tolist() == ["12"]
        assert audit["columnMapping"]["itemsViews"] == header
    for misleading in (
        "商品浏览量", "平均浏览商品数", "Просмотры товаров", "Среднее число просмотров"
    ):
        assert analyzer.normalize_header(misleading) not in analyzer.ALIAS_LOOKUP


def test_manual_review_flags_block_top30_but_preserve_detail_and_quadrants(tmp_path, offline_paths):
    input_path = tmp_path / "manual-review.csv"
    queries = ["омега", "мышка", "триммер", "органайзер для хранения"]
    pd.DataFrame([make_row(query) for query in queries]).to_csv(input_path, index=False)
    overrides = tmp_path / "translation-overrides.yaml"
    overrides.write_text(json.dumps({
        "queries": {
            "омега": {"review_flags": ["AMBIGUOUS_IDENTITY"]},
            "мышка": {"review_flags": "BRAND_REVIEW_REQUIRED|NOTE_ONLY"},
            "триммер": {"review_flags": ["AMBIGUOUS_IDENTITY", "BRAND_REVIEW_REQUIRED"]},
            "органайзер для хранения": {"review_flags": ["NOTE_ONLY"]},
        }
    }, ensure_ascii=False), encoding="utf-8")
    output = tmp_path / "manual-review-out"
    assert analyzer.main(cli_args(
        input_path, output, offline_paths, translation_overrides=overrides
    )) == 0
    workbook = load_workbook(output / "ozon_selection_report.xlsx")
    top = workbook["Top30_立项推荐"]
    top_headers = {cell.value: cell.column for cell in top[2]}
    assert top.max_row == 3
    assert top.cell(3, top_headers["query"]).value == "органайзер для хранения"
    assert top.cell(3, top_headers["manual_review_flags"]).value == "NOTE_ONLY"
    detail = workbook["四象限分类明细"]
    headers = {cell.value: cell.column for cell in detail[1]}
    rows = {
        detail.cell(row_index, headers["query"]).value: {
            column: detail.cell(row_index, column_index).value
            for column, column_index in headers.items()
        }
        for row_index in range(2, detail.max_row + 1)
    }
    for query in ("омега", "мышка", "триммер"):
        assert rows[query]["primary_quadrant"] == "蓝海缺口"
        assert rows[query]["top30_eligible"] is False
        assert rows[query]["top30_exclusion_reason"] == "MANUAL_IDENTITY_REVIEW"
        assert rows[query]["data_quality_status"] == "NUMERIC_FULL_4D_ONLY"
    assert rows["омега"]["manual_review_flags"] == "AMBIGUOUS_IDENTITY"
    assert rows["мышка"]["manual_review_flags"] == "BRAND_REVIEW_REQUIRED|NOTE_ONLY"
    assert rows["триммер"]["manual_review_flags"] == "AMBIGUOUS_IDENTITY|BRAND_REVIEW_REQUIRED"
    assert rows["органайзер для хранения"]["top30_eligible"] is True
    manifest = json.loads((output / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["filterFunnel"]["rawRows"] == 4
    assert manifest["filterFunnel"]["conservedRows"] == 4
    assert manifest["filterFunnel"]["top30Actual"] == 1
    assert manifest["translationOverrides"]["top30BlockingReviewFlags"] == [
        "AMBIGUOUS_IDENTITY", "BRAND_REVIEW_REQUIRED"
    ]
    assert "AMBIGUOUS_IDENTITY/BRAND_REVIEW_REQUIRED" in manifest["parameters"]["top30Rule"]
    assert manifest["metricSemantics"]["itemsViews"].startswith("展示商品数量")
    brief = (output / "ozon_selection_brief.md").read_text(encoding="utf-8")
    for expected in (
        "人工风险闸门", "MANUAL_IDENTITY_REVIEW", "NUMERIC_FULL_4D_ONLY",
        "不是独立方向或合格 SKU", "相关词必须合并调研", "日历起止与时区未知",
        "下单独立买家而非订单/件数", "而非结算收入", "不是本店可实现成交价",
    ):
        assert expected in brief
