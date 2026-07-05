// ============================================================
// Alert Route — receives Prometheus Alertmanager webhooks
// Relays alerts through the ONZO notifier → Telegram / WeChat
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { notifier } from "../services/notifier.js";

interface AlertmanagerWebhook {
  version: string;
  groupKey: string;
  status: "firing" | "resolved";
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL: string;
  alerts: Array<{
    status: "firing" | "resolved";
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    generatorURL: string;
  }>;
}

export function createAlertRouter(): Router {
  const router = Router();

  router.post("/alerts/prometheus", async (req, res) => {
    const payload = req.body as AlertmanagerWebhook;

    // Respond immediately — Alertmanager doesn't wait
    res.json({ status: "received" });

    logger.info({
      status: payload.status,
      alertCount: payload.alerts.length,
      groupKey: payload.groupKey,
    }, "Alertmanager webhook received");

    for (const alert of payload.alerts) {
      const severity = alert.labels.severity || "warning";
      const summary = alert.annotations.summary || alert.labels.alertname || "Unknown alert";
      const description = alert.annotations.description || "";

      // Route to notification channels
      await notifier.notify({
        level: severity === "critical" ? "critical" : severity === "warning" ? "warn" : "info",
        event: `[${payload.status.toUpperCase()}] ${summary}`,
        message: description,
        correlationId: `alert-${alert.labels.alertname || "unknown"}-${Date.now()}`,
        force: severity === "critical",
        metadata: {
          alertName: alert.labels.alertname,
          severity,
          status: alert.status,
          startsAt: alert.startsAt,
          generatorURL: alert.generatorURL,
        },
      }).catch((err) => {
        logger.error({ err: (err as Error).message }, "Failed to relay alert notification");
      });
    }
  });

  return router;
}
