import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getDb: vi.fn(),
  run: vi.fn(),
  all: vi.fn(),
  exec: vi.fn(),
  tx: vi.fn(),
}));

vi.mock("../src/db/connection.js", () => ({
  getDb: state.getDb,
  getAdapterType: () => "sqlite",
}));

import { initSchema } from "../src/db/schema.js";
import { insertCompetitorSnapshots, queryCompetitorPrices } from "../src/db/promo-db.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.tx.mockImplementation(async (fn: (db: { run: unknown }) => Promise<number>) => fn({ run: state.run }));
  state.getDb.mockResolvedValue({ run: state.run, all: state.all, exec: state.exec, tx: state.tx });
});

describe("competitor price types", () => {
  it("精准快照同时保存展示价、常规价与regular口径", async () => {
    const snapshot = {
      competitorUrl: "https://www.ozon.ru/product/3082687849/",
      price: 1495,
      priceRegular: 1661,
      priceType: "regular",
      rating: 4.9,
      salesCount: 384,
      capturedAt: "2026-11-03T09:20:47.224Z",
    };
    await expect(insertCompetitorSnapshots("A", [snapshot])).resolves.toBe(1);
    expect(state.tx).toHaveBeenCalledTimes(1);
    expect(state.run).toHaveBeenCalledWith(
      expect.stringContaining("price_regular"),
      ["A", snapshot.competitorUrl, 1495, 1661, "regular", 4.9, 384, snapshot.capturedAt],
    );
  });

  it("没有已验证常规价时拒绝精准快照，不写legacy伪装", async () => {
    await expect(insertCompetitorSnapshots("A", [{ competitorUrl: "x", price: 100, priceRegular: null, priceType: "regular" } as never])).rejects.toThrow("verified regular price");
    expect(state.run).not.toHaveBeenCalled();
  });

  it("查询默认返回常规价，旧记录显式保留legacy_unknown", async () => {
    state.all.mockResolvedValue([]);
    await queryCompetitorPrices("A", 3);
    const sql = state.all.mock.calls[0][0] as string;
    expect(sql).toContain("COALESCE(price_regular, price) AS price");
    expect(sql).toContain("COALESCE(price_type, 'legacy_unknown') AS \"priceType\"");
    expect(sql).toContain("price AS \"displayPrice\"");
    expect(sql).toContain("sales_count AS \"salesCount\"");
    expect(sql).toContain("captured_at AS \"capturedAt\"");
    expect(sql).toContain("competitor_url AS \"competitorUrl\"");
  });

  it("PostgreSQL初始化幂等增加字段且不回填旧价格", async () => {
    await initSchema({ exec: state.exec, run: state.run, all: state.all });
    const sql = state.exec.mock.calls[0][0] as string;
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS price_regular DOUBLE PRECISION");
    expect(sql).toContain("ALTER COLUMN price TYPE DOUBLE PRECISION");
    expect(sql).toContain("ALTER COLUMN price_regular TYPE DOUBLE PRECISION");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS price_type TEXT NOT NULL DEFAULT 'legacy_unknown'");
    expect(sql).not.toContain("UPDATE promo_competitor_prices SET price_regular");
  });
});
