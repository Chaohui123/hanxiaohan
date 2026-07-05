import client from "prom-client";

const register = new client.Registry();
register.setDefaultLabels({ app: "promo-agent" });

export const decisionCycleCounter = new client.Counter({
  name: "promo_decision_cycles_total",
  help: "Total number of decision cycles executed",
  labelNames: ["status"],
});
register.registerMetric(decisionCycleCounter);

export const productScoreGauge = new client.Gauge({
  name: "promo_product_score",
  help: "Current score of each product",
  labelNames: ["offerId", "recommendation"],
});
register.registerMetric(productScoreGauge);

export const actionCounter = new client.Counter({
  name: "promo_actions_total",
  help: "Total promo actions executed",
  labelNames: ["type", "result"],
});
register.registerMetric(actionCounter);

export const competitorCheckCounter = new client.Counter({
  name: "promo_competitor_checks_total",
  help: "Total competitor price checks",
  labelNames: ["result"],
});
register.registerMetric(competitorCheckCounter);

export const apiLatencyHistogram = new client.Histogram({
  name: "promo_api_latency_seconds",
  help: "API call latency from promo-agent",
  labelNames: ["endpoint"],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});
register.registerMetric(apiLatencyHistogram);

export const dailyActionGauge = new client.Gauge({
  name: "promo_daily_actions_current",
  help: "Current daily action count",
});
register.registerMetric(dailyActionGauge);

export { register };
