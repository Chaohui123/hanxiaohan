import { describe, expect, it } from "vitest";
import { directRetryDelayMs, parseDirectCampaignIds, parseDirectReportTsv, selectDirectCampaignRows, summarizeDirectRows, utcDayOffset } from "../../../scripts/direct-report-core.mjs";

const sample = `"ONZO report"
Date\tCampaignId\tCampaignName\tImpressions\tClicks\tCtr\tAvgCpc\tCost\tConversions\tCostPerConversion
2026-10-30\t715426752\tMarketplace\t471\t14\t2.97\t0.10\t1.47\t0\t--
2026-10-31\t715426752\tMarketplace\t424\t23\t5.42\t0.12\t2.72\t0\t--
2026-11-01\t715426752\tMarketplace\t672\t36\t5.36\t0.07\t2.50\t0\t--
2026-11-02\t715426752\tMarketplace\t612\t37\t6.05\t0.05\t1.84\t0\t--
Total rows: 4
`;

describe("Direct report parsing", () => {
  it("parses real report rows and keeps undefined CPA distinct from zero", () => {
    const rows = parseDirectReportTsv(sample);
    expect(rows).toHaveLength(4);
    expect(rows[0].campaignId).toBe("715426752");
    expect(rows[0].costPerConversionUsd).toBeNull();
    const summary = summarizeDirectRows(rows);
    expect(summary).toMatchObject({
      impressions: 2179,
      clicks: 110,
      ctrPercent: 5.05,
      costUsd: 8.53,
      conversions: 0,
      actualCpaUsd: null,
      daysWithActivity: 4,
    });
  });

  it("computes positive conversion CPA and boundaries", () => {
    const rows = parseDirectReportTsv(sample);
    const converted = rows.map((row, index) => index === 0 ? { ...row, conversions: 2 } : row);
    const summary = summarizeDirectRows(converted);
    expect(summary.actualCpaUsd).toBe(4.27);
    expect(summarizeDirectRows(rows, { from: "2026-10-31", to: "2026-11-01" })).toMatchObject({
      impressions: 1096,
      clicks: 59,
      costUsd: 5.22,
      daysWithActivity: 2,
    });
  });

  it("rejects missing, malformed, or negative data instead of fabricating zeros", () => {
    expect(() => parseDirectReportTsv("no report")).toThrow(/missing the TSV header/);
    expect(() => parseDirectReportTsv(sample.replace("Total rows: 4", "not-a-row"))).toThrow(/malformed TSV row/);
    expect(() => parseDirectReportTsv(sample.replace("471", "-1"))).toThrow(/invalid impressions/);
    expect(() => parseDirectReportTsv(sample.replaceAll("715426752", "not-a-number"))).toThrow(/campaign ID/);
  });

  it("does not truncate at blank rows and validates declared totals", () => {
    const withBlank = sample.replace("2026-11-01", "\n2026-11-01");
    expect(parseDirectReportTsv(withBlank)).toHaveLength(4);
    expect(() => parseDirectReportTsv(sample.replace("Total rows: 4", "Total rows: 3"))).toThrow(/row count mismatch/);
  });

  it("accepts an explicit zero-row report as real zero activity", () => {
    const empty = sample.replace(/^2026-.*\n/gm, "").replace("Total rows: 4", "Total rows: 0");
    const rows = parseDirectReportTsv(empty);
    expect(rows).toEqual([]);
    expect(summarizeDirectRows(rows, { from: "2026-10-27", to: "2026-11-02" })).toMatchObject({
      impressions: 0,
      clicks: 0,
      costUsd: 0,
      conversions: 0,
      actualCpaUsd: null,
      daysWithActivity: 0,
    });
  });

  it("keeps multiple campaigns separate and validates configured IDs", () => {
    const rows = parseDirectReportTsv(sample);
    const candidate = rows.map(row => ({ ...row, campaignId: "716088179", costUsd: 2, conversions: 1 }));
    const selected = selectDirectCampaignRows([...rows, ...candidate], "716088179");
    expect(selected).toHaveLength(4);
    expect(summarizeDirectRows(selected)).toMatchObject({ costUsd: 8, conversions: 4, actualCpaUsd: 2 });
    expect(selectDirectCampaignRows(rows, "716088179")).toEqual([]);
    expect(parseDirectCampaignIds("715426752, 716088179,715426752")).toEqual(["715426752", "716088179"]);
    expect(() => parseDirectCampaignIds("715426752,bad")).toThrow("Invalid Direct campaign ID list");
  });

  it("handles UTC calendar offsets across month boundaries", () => {
    expect(utcDayOffset("2026-11-02", -29)).toBe("2026-10-04");
    expect(utcDayOffset("2026-03-01", -1)).toBe("2026-02-28");
    expect(utcDayOffset("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("handles numeric and HTTP-date Retry-After without immediate retry", () => {
    expect(directRetryDelayMs("3")).toBe(3000);
    expect(directRetryDelayMs("not-a-date")).toBe(5000);
    expect(directRetryDelayMs("0")).toBe(1000);
    const now = Date.parse("2026-11-03T00:00:00.000Z");
    expect(directRetryDelayMs("Tue, 03 Nov 2026 00:00:20 GMT", now)).toBe(15000);
    expect(directRetryDelayMs("Tue, 03 Nov 2026 00:00:02 GMT", now)).toBe(2000);
  });
});
