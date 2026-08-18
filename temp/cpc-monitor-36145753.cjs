// CPC campaign 36145753 "61N CPC" — read-only monitor
// Only GETs + statistics POSTs (report generation). No mutations.
const fs = require("fs");
const { perf } = require("./perf-api.cjs");

const CID = "36145753";
const FROM = "2026-08-18"; // campaign created 18.08.2026
const TO = new Date().toISOString().slice(0, 10);

const num = (s) => (s == null || s === "" ? 0 : parseFloat(String(s).replace(/\s/g, "").replace(",", ".")) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = { fetchedAtUtc: new Date().toISOString(), campaignId: CID, range: { from: FROM, to: TO } };

  // 1) campaign detail (filtered list endpoint — the only documented GET that returns full fields)
  const camp = await perf(`/api/client/campaign?campaignIds=${CID}&advObjectType=SKU&state=CAMPAIGN_STATE_RUNNING`);
  out.campaign = { status: camp.status, data: camp.data };

  // 2) products bound to the campaign
  const prods = await perf(`/api/client/campaign/${CID}/v2/products`);
  out.products = { status: prods.status, data: prods.data };

  // 3) daily stats JSON (all campaigns; ours may be absent => zero traffic)
  const daily = await perf(`/api/client/statistics/daily/json?dateFrom=${FROM}&dateTo=${TO}`);
  out.daily = { status: daily.status, data: daily.data };

  // 4) product-level summary CSV
  const prodStat = await perf(`/api/client/statistics/campaign/product?campaignIds=${CID}&dateFrom=${FROM}&dateTo=${TO}`);
  out.productStat = { status: prodStat.status, data: prodStat.data };

  // 5) async full report (grouped by date)
  const req = await perf(`/api/client/statistics`, {
    campaigns: [CID],
    from: FROM + "T00:00:00Z",
    to: TO + "T23:59:59Z",
    groupBy: "DATE",
  });
  out.reportRequest = { status: req.status, data: req.data };
  if (req.data?.UUID) {
    for (let i = 0; i < 6; i++) {
      await sleep(4000);
      const rep = await perf(`/api/client/statistics/${req.data.UUID}`);
      out.report = { status: rep.status, data: rep.data, attempt: i + 1 };
      const state = rep.data?.state || rep.data?.status;
      if (state && !/NOT_STARTED|IN_PROGRESS/i.test(String(state))) break;
      if (rep.status === 200 && (rep.data?.report || rep.data?.rows || Array.isArray(rep.data))) break;
    }
  }

  // ---- compute ----
  const c = (camp.data?.list || [])[0] || {};
  const dailyRows = (daily.data?.rows || []).filter((r) => String(r.id) === CID);
  let shows = 0, clicks = 0, spent = 0, orders = 0, ordersMoney = 0;
  for (const r of dailyRows) {
    shows += num(r.views); clicks += num(r.clicks); spent += num(r.moneySpent);
    orders += num(r.orders); ordersMoney += num(r.ordersMoney);
  }
  out.computed = {
    dailyRows,
    totals: { shows, clicks, moneySpentRub: spent, orders, ordersMoneyRub: ordersMoney },
    ctrPct: shows ? (clicks / shows) * 100 : null,
    avgCpcRub: clicks ? spent / clicks : null,
    roas: spent ? ordersMoney / spent : null,
  };

  fs.writeFileSync("temp/cpc-monitor-36145753.json", JSON.stringify(out, null, 2));
  console.log("SAVED temp/cpc-monitor-36145753.json");
  console.log(JSON.stringify(out.computed, null, 2));
  console.log("campaign:", JSON.stringify(c).slice(0, 800));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
