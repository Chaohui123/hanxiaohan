// import-status-sync — backfill real product_id tests (in-memory SQLite + mock client)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSqliteTestDb } from "../helpers/test-db.js";

const mockGetImportStatus = vi.fn();
vi.mock("@onzo/ozon-api-wrapper", () => ({
  OzonClient: vi.fn().mockImplementation(() => ({
    getImportStatus: (...args: unknown[]) => mockGetImportStatus(...args),
  })),
}));

const DDL = `
CREATE TABLE listing_records (
  id TEXT PRIMARY KEY, source_url TEXT, status TEXT, draft_id TEXT,
  ozon_product_id INTEGER, correlation_id TEXT, result_json TEXT, created_at TEXT
);
CREATE TABLE sku_1688_mapping (
  id TEXT PRIMARY KEY, store_id TEXT, ozon_offer_id TEXT, ozon_sku INTEGER,
  source_1688_url TEXT, purchase_price_cny REAL, updated_at TEXT
)`;

let dbCtx: ReturnType<typeof createSqliteTestDb>;

vi.mock("../../src/db/connection.js", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(dbCtx.adapter)),
  serializedWrite: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));

describe("import-status-sync", () => {
  beforeEach(async () => {
    dbCtx = createSqliteTestDb();
    await dbCtx.adapter.exec(DDL);
    vi.clearAllMocks();
  });

  it("backfills real product_id into listing_records and sku_1688_mapping on imported", async () => {
    await dbCtx.adapter.run(
      "INSERT INTO listing_records (id, status, draft_id, ozon_product_id, created_at) VALUES ('lr-1', 'processing', 'task_5164', 5164731660, '2026-07-22 01:00:00')",
      []
    );
    await dbCtx.adapter.run(
      "INSERT INTO sku_1688_mapping (id, store_id, ozon_offer_id, ozon_sku, source_1688_url, purchase_price_cny) VALUES ('m-1', 'store_1', 'task_5164', 5164731660, 'http://1688', 25)",
      []
    );
    mockGetImportStatus.mockResolvedValue({
      offerId: "onzo-abc", productId: 5601249994, status: "imported", errors: [],
    });

    const { syncImportStatuses } = await import("../../src/services/import-status-sync.js");
    const { OzonClient } = await import("@onzo/ozon-api-wrapper");
    const result = await syncImportStatuses(new (OzonClient as never)() as never);

    expect(result.backfilled).toBe(1);

    const listing = dbCtx.db.prepare("SELECT ozon_product_id, status FROM listing_records WHERE id = 'lr-1'").get() as { ozon_product_id: number; status: string };
    expect(listing).toEqual({ ozon_product_id: 5601249994, status: "done" });

    const mapping = dbCtx.db.prepare("SELECT ozon_sku FROM sku_1688_mapping WHERE id = 'm-1'").get() as { ozon_sku: number };
    expect(mapping.ozon_sku).toBe(5601249994);
  });

  it("marks listing failed when import task failed", async () => {
    await dbCtx.adapter.run(
      "INSERT INTO listing_records (id, status, draft_id, ozon_product_id, created_at) VALUES ('lr-2', 'processing', 'task_x', 111, '2026-07-22 01:00:00')",
      []
    );
    mockGetImportStatus.mockResolvedValue({
      offerId: "", productId: 0, status: "failed",
      errors: [{ code: "attr_empty", field: "9048", description: "model name empty" }],
    });

    const { syncImportStatuses } = await import("../../src/services/import-status-sync.js");
    const { OzonClient } = await import("@onzo/ozon-api-wrapper");
    const result = await syncImportStatuses(new (OzonClient as never)() as never);

    expect(result.failed).toBe(1);
    const listing = dbCtx.db.prepare("SELECT status FROM listing_records WHERE id = 'lr-2'").get() as { status: string };
    expect(listing.status).toBe("failed");
  });

  it("leaves processing records untouched when still importing", async () => {
    await dbCtx.adapter.run(
      "INSERT INTO listing_records (id, status, draft_id, ozon_product_id, created_at) VALUES ('lr-3', 'processing', 'task_y', 222, '2026-07-22 01:00:00')",
      []
    );
    mockGetImportStatus.mockResolvedValue({ offerId: "", productId: 0, status: "processing", errors: [] });

    const { syncImportStatuses } = await import("../../src/services/import-status-sync.js");
    const { OzonClient } = await import("@onzo/ozon-api-wrapper");
    const result = await syncImportStatuses(new (OzonClient as never)() as never);

    expect(result.stillProcessing).toBe(1);
    const listing = dbCtx.db.prepare("SELECT ozon_product_id, status FROM listing_records WHERE id = 'lr-3'").get() as { ozon_product_id: number; status: string };
    expect(listing).toEqual({ ozon_product_id: 222, status: "processing" });
  });
});
