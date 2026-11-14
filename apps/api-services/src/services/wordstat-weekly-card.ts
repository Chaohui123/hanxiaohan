import type { WeeklyReport } from "./wordstat-weekly.js";

function text(value: unknown, fallback = "—"): string {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function number(value: unknown, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

function searchUrl(value: unknown, phrase: string, ozon: boolean): string {
  if (typeof value === "string" && value.startsWith("https://")) return value;
  return `${ozon ? "https://www.ozon.ru/search/?text=" : "https://yandex.ru/search/?text="}${encodeURIComponent(phrase)}`;
}

export function buildWordstatWeeklyCard(report: WeeklyReport): Record<string, unknown> {
  const failed = report.overallStatus === "failed_alert_only";
  const partial = report.overallStatus === "degraded_partial";
  const observations = report.top10Observations as Array<Record<string, unknown>>;
  const lines = observations.map((item, index) => {
    const score = item.score as Record<string, unknown> | undefined;
    const wow = item.wowRate === null || item.wowRate === undefined ? "—" : `${(Number(item.wowRate) * 100).toFixed(2)}%`;
    const cities = Array.isArray(item.referenceCities) ? item.referenceCities as Array<Record<string, unknown>> : [];
    const cityText = cities.map(city => `${text(city.nameZh)} share=${city.rawShare === null || city.rawShare === undefined ? "—" : Number(city.rawShare).toFixed(6)} / affinity=${number(city.affinityIndex)}`).join("；");
    return `${index + 1}. **${text(item.phrase)}**（${text(item.zhDraft)}）\n有效周量 ${text(item.effectiveWeeklyVolume)}｜WoW ${wow}｜观察分 ${number(score?.observationPriorityScore)}\n${cityText || "城市指标未返回，不补0"}`;
  });
  const seasonal = observations.filter(item => (item.seasonality as Record<string, unknown> | undefined)?.status === "upcoming_peak_window");
  const seasonalText = seasonal.length ? seasonal.map(item => {
    const hint = item.seasonality as Record<string, unknown>;
    return `**${text(item.phrase)}**：预计距历史波峰 ${Array.isArray(hint.estimatedDaysBand) ? hint.estimatedDaysBand.join("–") : "—"} 天（周粒度估计，仅补证与内容准备）`;
  }).join("\n") : "当前没有满足历史数据完整性与60–90天窗口的提示；不猜测波峰、不提前备货。";
  const failureText = (report.failedRequests as Array<Record<string, unknown>>).slice(0, 5).map(item => `${text(item.phrase)}：${text(item.errorType)}（HTTP ${text(item.httpStatus)}）`).join("\n");
  const elements: Array<Record<string, unknown>> = [
    { tag: "div", text: { tag: "lark_md", content: `**报告ID**：${report.reportId}\n**实际数据截止**：${text(report.globalSourceAsOfMax, "未返回")}\n**Seller原生7天/自建28天**：7天 / ${text((report.sellerValidationContext as Record<string, unknown>).selfBuiltProgressLabel)}\n**说明**：观察排序不等于上架资格；缺失、过期与UNCERTAIN不写成0。` } },
    { tag: "hr" },
    { tag: "div", text: { tag: "lark_md", content: `${observations.some(item => Number.isFinite((item.score as Record<string, unknown> | undefined)?.observationPriorityScore)) ? `**本周有效评分观察Top ${observations.length}**` : `**本次没有有效评分Top10；以下为实际观察池（${observations.length}词，不代表合格候选）**`}\n${lines.join("\n\n") || "本次没有可评分词；请查看缺失与告警，不伪造Top10。"}` } },
  ];
  for (const item of observations) {
    const phrase = text(item.phrase);
    elements.push({ tag: "action", actions: [
      { tag: "button", text: { tag: "plain_text", content: `Yandex：${phrase.slice(0, 30)}` }, type: "default", url: searchUrl(item.yandexSearchUrl, phrase, false) },
      { tag: "button", text: { tag: "plain_text", content: `Ozon：${phrase.slice(0, 30)}` }, type: "default", url: searchUrl(item.ozonSearchUrl, phrase, true) },
    ] });
  }
  elements.push(
    { tag: "hr" },
    { tag: "div", text: { tag: "lark_md", content: `**季节性补证提示**\n${seasonalText}` } },
  );
  if (failureText) elements.push({ tag: "div", text: { tag: "lark_md", content: `**异常与配额告警**\n${failureText}` } });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: "仅作选品观察；需竞争、供货、真实经济、合规、8图双视频及独立复核。不自动上架、采购或改价。" }] });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: failed ? "red" : partial ? "orange" : "blue",
        title: { tag: "plain_text", content: `【Ozon选品观察周报】Yandex Wordstat趋势与季节性补证提示（${report.runDate}）` },
      },
      elements,
    },
  };
}
