function numberValue(value) {
  if (value === undefined || value === "" || value === "--") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid Direct numeric value: ${value}`);
  return number;
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parseDirectReportTsv(text) {
  const lines = String(text).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("Date\t"));
  if (headerIndex < 0) throw new Error("Direct report is missing the TSV header");
  const headers = lines[headerIndex].split("\t");
  for (const field of ["Date", "CampaignId", "Impressions", "Clicks", "Cost", "Conversions"]) {
    if (!headers.includes(field)) throw new Error(`Direct report is missing ${field}`);
  }
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.startsWith("Total rows:")) {
      const declared = Number(line.slice("Total rows:".length).trim());
      if (Number.isFinite(declared) && declared !== rows.length) throw new Error(`Direct report row count mismatch: declared ${declared}, parsed ${rows.length}`);
      break;
    }
    if (!line) continue;
    const values = line.split("\t");
    if (values.length !== headers.length) throw new Error("Direct report contains a malformed TSV row");
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    rows.push({
      date: row.Date,
      campaignId: String(row.CampaignId),
      campaignName: row.CampaignName || null,
      impressions: numberValue(row.Impressions),
      clicks: numberValue(row.Clicks),
      ctrPercent: numberValue(row.Ctr),
      avgCpcUsd: numberValue(row.AvgCpc),
      costUsd: numberValue(row.Cost),
      conversions: numberValue(row.Conversions),
      costPerConversionUsd: numberValue(row.CostPerConversion),
    });
  }
  if (!rows.length && !lines.some((line) => line.trim() === "Total rows: 0")) throw new Error("Direct report contains no daily rows");
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !/^\d+$/.test(row.campaignId)) throw new Error("Direct report contains an invalid date or campaign ID");
    for (const field of ["impressions", "clicks", "costUsd", "conversions"]) {
      if (row[field] === null || row[field] < 0) throw new Error(`Direct report contains an invalid ${field}`);
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.campaignId.localeCompare(b.campaignId));
}

export function summarizeDirectRows(rows, { from, to } = {}) {
  const selected = rows.filter((row) => (!from || row.date >= from) && (!to || row.date <= to));
  const totals = selected.reduce((sum, row) => ({
    impressions: sum.impressions + row.impressions,
    clicks: sum.clicks + row.clicks,
    costUsd: sum.costUsd + row.costUsd,
    conversions: sum.conversions + row.conversions,
  }), { impressions: 0, clicks: 0, costUsd: 0, conversions: 0 });
  return {
    from: from || selected[0]?.date || null,
    to: to || selected.at(-1)?.date || null,
    daysWithActivity: new Set(selected.map((row) => row.date)).size,
    campaignIds: [...new Set(selected.map((row) => row.campaignId))],
    impressions: totals.impressions,
    clicks: totals.clicks,
    ctrPercent: totals.impressions > 0 ? money(totals.clicks * 100 / totals.impressions) : null,
    costUsd: money(totals.costUsd),
    avgCpcUsd: totals.clicks > 0 ? money(totals.costUsd / totals.clicks) : null,
    conversions: totals.conversions,
    actualCpaUsd: totals.conversions > 0 ? money(totals.costUsd / totals.conversions) : null,
    actualCpaNote: totals.conversions > 0 ? null : "No conversions, so actual CPA is undefined; report dashes or zeros are not free acquisition",
  };
}

export function directRetryDelayMs(value, now = Date.now()) {
  const numeric = Number(value);
  let delay = Number.isFinite(numeric) && value !== null && String(value).trim() !== "" ? numeric * 1000 : NaN;
  if (!Number.isFinite(delay) && value) {
    const date = Date.parse(String(value));
    delay = Number.isFinite(date) ? date - now : NaN;
  }
  if (!Number.isFinite(delay)) delay = 5000;
  return Math.min(Math.max(delay, 1000), 15000);
}

export function utcDayOffset(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
