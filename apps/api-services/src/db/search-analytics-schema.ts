export const SEARCH_ANALYTICS_DDL = `
  CREATE TABLE IF NOT EXISTS ozon_search_collection_runs (
    run_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    status TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_dependency TEXT NOT NULL,
    native_period TEXT NOT NULL,
    period_start TEXT,
    period_end TEXT,
    timezone TEXT,
    anchor_at TEXT,
    filters_json TEXT NOT NULL,
    filter_hash TEXT NOT NULL,
    collector_version TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    coverage TEXT NOT NULL,
    expected_pages INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    total_rows BIGINT NOT NULL DEFAULT 0,
    row_count BIGINT NOT NULL DEFAULT 0,
    fields_json TEXT NOT NULL DEFAULT '[]',
    pages_json TEXT NOT NULL DEFAULT '[]',
    manifest_json TEXT NOT NULL DEFAULT '{}',
    content_sha256 TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TIMESTAMP DEFAULT (NOW())
  );
  CREATE INDEX IF NOT EXISTS idx_search_runs_company_anchor ON ozon_search_collection_runs(company_id, anchor_at DESC);
  CREATE INDEX IF NOT EXISTS idx_search_runs_status_filter ON ozon_search_collection_runs(status, filter_hash, anchor_at DESC);

  CREATE TABLE IF NOT EXISTS ozon_search_query_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ozon_search_collection_runs(run_id),
    company_id TEXT NOT NULL,
    query_text TEXT NOT NULL,
    normalized_query TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    row_number INTEGER NOT NULL,
    collected_at TEXT NOT NULL,
    search_popularity BIGINT,
    cart_additions BIGINT,
    cart_conversion_pct DOUBLE PRECISION,
    unique_buyers BIGINT,
    order_conversion_pct DOUBLE PRECISION,
    ordered_revenue_rub NUMERIC(20,2),
    average_price_rub NUMERIC(20,2),
    shown_items_count BIGINT,
    competitor_sellers_count BIGINT,
    no_action_queries BIGINT,
    no_action_share_pct DOUBLE PRECISION,
    similar_queries BIGINT,
    similar_share_pct DOUBLE PRECISION,
    no_result_queries BIGINT,
    no_result_share_pct DOUBLE PRECISION,
    dynamic_28_pct DOUBLE PRECISION,
    dynamic_7_pct DOUBLE PRECISION,
    seasonality_json TEXT,
    metrics_json TEXT NOT NULL,
    raw_row_sha256 TEXT NOT NULL,
    UNIQUE(run_id, query_text)
  );
  CREATE INDEX IF NOT EXISTS idx_search_snapshots_run ON ozon_search_query_snapshots(run_id, search_popularity DESC);
  CREATE INDEX IF NOT EXISTS idx_search_snapshots_query ON ozon_search_query_snapshots(company_id, normalized_query, collected_at DESC);

  CREATE TABLE IF NOT EXISTS ozon_search_raw_responses (
    run_id TEXT NOT NULL REFERENCES ozon_search_collection_runs(run_id),
    page_number INTEGER NOT NULL,
    request_json TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    object_path TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    server_date TEXT,
    PRIMARY KEY(run_id, page_number)
  );

  CREATE TABLE IF NOT EXISTS ozon_search_derived_windows (
    derived_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    anchor_at TEXT NOT NULL,
    coverage_status TEXT NOT NULL,
    source_run_ids_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    query_text TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT (NOW()),
    UNIQUE(company_id, anchor_at, algorithm_version, query_text)
  );
  CREATE INDEX IF NOT EXISTS idx_search_derived_anchor ON ozon_search_derived_windows(company_id, anchor_at DESC, query_text);
`;
