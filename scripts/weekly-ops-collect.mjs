const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is required");

async function api(route) {
  const response = await fetch(`http://127.0.0.1:3000${route}`, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${JSON.stringify(data).slice(0, 250)}`);
  return data;
}

function utcDay(offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const [board, linksResponse, localOrders, pricing, ads] = await Promise.all([
  api("/api/promo/operations-board?days=7"),
  api("/api/promo/competitor-links"),
  api("/api/stats/weekly"),
  api("/api/promo/pricing-history?days=7"),
  import("./apps/api-services/dist/services/ozon-ads.js").then(({ getAdDailyStats }) => getAdDailyStats(utcDay(-6), utcDay())),
]);

if (!board.success || !Array.isArray(board.items) || !Array.isArray(linksResponse.items)) {
  throw new Error("Required operations or competitor data is unavailable");
}

const linksByOffer = new Map();
for (const link of linksResponse.items) {
  const rows = linksByOffer.get(link.offerId) || [];
  rows.push(link);
  linksByOffer.set(link.offerId, rows);
}
const coverage = board.items.map((item) => {
  const links = linksByOffer.get(item.offerId) || [];
  return {
    offerId: item.offerId,
    linkCount: links.length,
    lastCapturedAt: links.map((link) => link.lastCapturedAt).filter(Boolean).sort().at(-1) || null,
  };
});
const adjustments = Array.isArray(pricing.adjustments) ? pricing.adjustments : [];
const nonzeroOldPrices = adjustments.filter((item) => Number(item.oldPrice ?? item.oldprice ?? 0) > 0).length;
const report = {
  schemaVersion: 1,
  collectedAt: new Date().toISOString(),
  operationsPeriod: board.period,
  operationsTotals: board.totals,
  sourceStatus: board.sourceStatus,
  items: board.items.map(({ warnings, ...item }) => item),
  revenueDefinition: "orderedRevenueRub is order-based revenue, not settled receipts or net profit",
  localOrders: {
    period: { from: utcDay(-7), to: utcDay(-1) },
    ...localOrders,
    note: "Local non-cancelled orders; this period differs from the operations board by one day",
  },
  ozonAds: {
    period: { from: utcDay(-6), to: utcDay() },
    data: ads,
    unavailableMeansNotZero: true,
  },
  competitorCoverage: {
    activeOffers: board.items.length,
    coveredOffers: coverage.filter((item) => item.linkCount > 0).length,
    totalLinks: linksResponse.items.length,
    missingOfferIds: coverage.filter((item) => item.linkCount === 0).map((item) => item.offerId),
    items: coverage,
  },
  recentPricingAudit: {
    count: adjustments.length,
    nonzeroOldPrices,
    note: "Audit records alone do not prove an Ozon price change; zero-old-price records are not valid before/after evidence",
  },
};

console.log(JSON.stringify(report, null, 2));
