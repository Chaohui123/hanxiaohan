// CPC campaign 36145753 "61N CPC" — read-only monitor
// Only GETs + statistics POSTs (report generation). No mutations.
const fs = require("fs");
const { perf } = require("./perf-api.cjs");

const CID = "36145753";
const CAMPAIGN_FROM = "2026-08-18";
const MAX_RANGE_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;

const num = (s) => (s == null || s === "" ? 0 : parseFloat(String(s).replace(/\s/g, "").replace(",", ".")) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rollingRange(to, campaignFrom = CAMPAIGN_FROM) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
    throw new Error(`Invalid range end: ${to}`);
  }
  const earliest = new Date(Date.parse(`${to}T00:00:00Z`) - (MAX_RANGE_DAYS - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  const from = campaignFrom > earliest ? campaignFrom : earliest;
  if (from > to) throw new Error(`Invalid range: ${from} > ${to}`);
  return { from, to };
}

function apiResult(response) {
  const httpStatus = response?.status ?? null;
  const ok = Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300;
  return {
    status: ok ? "ok" : "error",
    httpStatus,
    data: response?.data ?? null,
    ...(!ok ? { error: response?.error || `Performance API HTTP ${httpStatus ?? "network failure"}` } : {}),
  };
}

async function safePerf(path, body) {
  try {
    return apiResult(await perf(path, body));
  } catch (error) {
    return apiResult({ error: error instanceof Error ? error.message : String(error) });
  }
}

function getCampaign(data) {
  return Array.isArray(data?.list) ? data.list[0] || null : null;
}

function dailyTotals(data, campaignId = CID) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const dailyRows = rows.filter((row) => String(row?.id) === campaignId);
  let shows = 0, clicks = 0, spent = 0, orders = 0, ordersMoney = 0;
  for (const row of dailyRows) {
    shows += num(row.views); clicks += num(row.clicks); spent += num(row.moneySpent);
    orders += num(row.orders); ordersMoney += num(row.ordersMoney);
  }
  return {
    dailyRows,
    totals: { shows, clicks, moneySpentRub: spent, orders, ordersMoneyRub: ordersMoney },
    ctrPct: shows ? (clicks / shows) * 100 : null,
    avgCpcRub: clicks ? spent / clicks : null,
    roas: spent ? ordersMoney / spent : null,
  };
}

function computeMonitor(out) {
  const sources = [out.campaign, out.products, out.daily, out.productStat, out.reportRequest, out.report];
  if (sources.some((source) => source?.status !== "ok")) return null;
  return dailyTotals(out.daily.data, out.campaignId);
}

async function main() {
  const range = rollingRange(new Date().toISOString().slice(0, 10));
  const out = {
    fetchedAtUtc: new Date().toISOString(),
    campaignId: CID,
    requestedFrom: CAMPAIGN_FROM,
    range,
    maxRangeDays: MAX_RANGE_DAYS,
  };

  // No state filter: inactive campaigns must remain visible.
  out.campaign = await safePerf(`/api/client/campaign?campaignIds=${CID}&advObjectType=SKU`);
  if (out.campaign.status === "ok" && !getCampaign(out.campaign.data)) {
    out.campaign.status = "not_found";
  }

  out.products = await safePerf(`/api/client/campaign/${CID}/v2/products`);
  out.daily = await safePerf(`/api/client/statistics/daily/json?dateFrom=${range.from}&dateTo=${range.to}`);
  out.productStat = await safePerf(`/api/client/statistics/campaign/product?campaignIds=${CID}&dateFrom=${range.from}&dateTo=${range.to}`);

  out.reportRequest = await safePerf(`/api/client/statistics`, {
    campaigns: [CID],
    from: range.from + "T00:00:00Z",
    to: range.to + "T23:59:59Z",
    groupBy: "DATE",
  });
  if (out.reportRequest.status === "ok" && out.reportRequest.data?.UUID) {
    for (let i = 0; i < 6; i++) {
      await sleep(4000);
      const rep = await safePerf(`/api/client/statistics/${out.reportRequest.data.UUID}`);
      out.report = { ...rep, attempt: i + 1 };
      if (rep.status === "error") break;
      const state = rep.data?.state || rep.data?.status;
      if (state && /ERROR|FAILED/i.test(String(state))) {
        out.report = { ...out.report, status: "error", error: `Report state: ${state}` };
        break;
      }
      if (state && !/NOT_STARTED|IN_PROGRESS/i.test(String(state))) break;
      if (rep.data?.report || rep.data?.rows || Array.isArray(rep.data)) break;
    }
    if (out.report?.status === "ok") {
      const state = out.report.data?.state || out.report.data?.status;
      if ((!state || /NOT_STARTED|IN_PROGRESS/i.test(String(state))) &&
          !out.report.data?.report && !out.report.data?.rows && !Array.isArray(out.report.data)) {
        out.report = { ...out.report, status: "error", error: "Report was not ready after 6 attempts" };
      }
    }
  } else if (out.reportRequest.status === "ok") {
    out.report = { status: "error", httpStatus: out.reportRequest.httpStatus, data: null, error: "Report response has no UUID" };
  }

  out.computed = computeMonitor(out);
  fs.writeFileSync("temp/cpc-monitor-36145753.json", JSON.stringify(out, null, 2));
  console.log("SAVED temp/cpc-monitor-36145753.json");
  console.log(JSON.stringify(out.computed, null, 2));
  console.log("campaign:", JSON.stringify(getCampaign(out.campaign.data)).slice(0, 800));
}

if (require.main === module) {
  main().catch((error) => { console.error("FATAL", error); process.exit(1); });
}

module.exports = { apiResult, computeMonitor, dailyTotals, getCampaign, main, rollingRange };
