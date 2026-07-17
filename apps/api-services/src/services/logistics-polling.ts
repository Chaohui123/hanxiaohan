// ============================================================
// Logistics Polling Service — track 1688 domestic shipments
// Polls paid purchases for tracking numbers, pushes to freight
// forwarder, alerts on >48h no-pickup delays.
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent } from "./notification-events.js";

// ---- Config ----

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const NO_PICKUP_THRESHOLD_HOURS = 48;
const MAX_BATCH_SIZE = 50;

// ---- Freight Forwarder Interface ----

export interface FreightForwarderConfig {
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface ParcelInfo {
  trackingNumber: string;
  carrier: string;
  ozonPostingNumber: string;
  weightKg: number;
  skuList: Array<{ sku: number; quantity: number }>;
  originAddress?: string;
  estimatedDelivery?: string;
}

let forwarderConfig: FreightForwarderConfig = {
  apiUrl: process.env.FREIGHT_FORWARDER_API_URL || "",
  apiKey: process.env.FREIGHT_FORWARDER_API_KEY || "",
  enabled: !!(process.env.FREIGHT_FORWARDER_API_URL && process.env.FREIGHT_FORWARDER_API_KEY),
};

// ---- Types ----

interface PurchaseRow {
  id: string;
  store_id: string;
  ozon_posting_number: string;
  ozon_order_id: number;
  total_amount_cny: number;
  payment_status: string;
  pay_time: string;
  logistics_status: string;
  logistics_tracking: string | null;
  sku_list_json: string;
  source_1688_url: string;
  offer_id: string;
}

interface TrackingResult {
  trackingNumber: string;
  carrier: string;
  status: string;
  events: Array<{ timestamp: string; location: string; description: string }>;
}

// ---- 1688 Logistics Trace ----

async function query1688Tracking(trackingNumber: string): Promise<TrackingResult | null> {
  try {
    const { getLogisticsTrace } = await import("./alibaba-openplatform.js");
    if (typeof getLogisticsTrace === "function") {
      const trace = await getLogisticsTrace(trackingNumber);
      if (trace) {
        return {
          trackingNumber: trace.trackingNumber,
          carrier: trace.details?.[0]?.status || "unknown",
          status: trace.status || "unknown",
          events: trace.details?.map((d) => ({ timestamp: d.time, location: d.location || "", description: d.status })) || [],
        };
      }
    }
    return null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, trackingNumber }, "1688 logistics trace failed");
    return null;
  }
}

// ---- Freight Forwarder Push ----

async function pushToFreightForwarder(parcel: ParcelInfo): Promise<boolean> {
  if (!forwarderConfig.enabled) return false;

  try {
    const resp = await fetch(`${forwarderConfig.apiUrl}/api/parcels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${forwarderConfig.apiKey}`,
      },
      body: JSON.stringify(parcel),
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.ok) {
      logger.info({ tracking: parcel.trackingNumber, ozon: parcel.ozonPostingNumber }, "Parcel pushed to freight forwarder");
      return true;
    }
    logger.warn({ status: resp.status, tracking: parcel.trackingNumber }, "Freight forwarder push failed");
    return false;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Freight forwarder push error");
    return false;
  }
}

// ---- No-Pickup Detection ----

function hoursSince(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function hasPickupScan(events: Array<{ description: string }>): boolean {
  const keywords = ["揽收", "已揽件", "pickup", "picked up", "已收件", "快递员收件", "收件"];
  return events.some((e) => keywords.some((kw) => e.description.toLowerCase().includes(kw.toLowerCase())));
}

// ---- Main Polling Logic ----

export async function pollLogistics(): Promise<{
  checked: number;
  updated: number;
  pushed: number;
  alerted: number;
}> {
  const result = { checked: 0, updated: 0, pushed: 0, alerted: 0 };
  const db = await getDb().catch(() => null);
  if (!db) {
    logger.warn("Logistics polling skipped — DB unavailable");
    return result;
  }

  // Find paid purchases without complete logistics tracking
  const rows = await db.all<PurchaseRow>(
    `SELECT * FROM purchase_1688
     WHERE payment_status = 'paid'
       AND (logistics_status = 'idle' OR logistics_status = 'shipped' OR logistics_status IS NULL)
     ORDER BY pay_time ASC
     LIMIT ?`,
    [MAX_BATCH_SIZE],
  );

  result.checked = rows.length;
  if (rows.length === 0) return result;

  for (const row of rows) {
    try {
      // Try to get tracking from 1688 API (if we have a tracking number already from callback)
      let tracking: TrackingResult | null = null;
      if (row.logistics_tracking) {
        tracking = await query1688Tracking(row.logistics_tracking);
      }

      if (tracking && tracking.trackingNumber) {
        // Update purchase record with tracking info
        await db.run(
          `UPDATE purchase_1688
           SET logistics_tracking = ?, logistics_status = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [tracking.trackingNumber, tracking.status, row.id],
        );
        result.updated++;

        // Push to freight forwarder
        const skuList = JSON.parse(row.sku_list_json || "[]") as Array<{ sku: number; quantity: number }>;
        const pushed = await pushToFreightForwarder({
          trackingNumber: tracking.trackingNumber,
          carrier: tracking.carrier,
          ozonPostingNumber: row.ozon_posting_number,
          weightKg: 0.5,
          skuList,
        });
        if (pushed) result.pushed++;

        continue;
      }

      // No tracking yet — check for delay (>48h since payment, no pickup scan)
      const hours = hoursSince(row.pay_time);
      if (hours > NO_PICKUP_THRESHOLD_HOURS) {
        const hasPickup = tracking ? hasPickupScan(tracking.events) : false;
        if (!hasPickup) {
          logger.warn(
            { postingNumber: row.ozon_posting_number, hours: Math.round(hours), purchaseId: row.id },
            "Logistics delay — no pickup scan within 48h",
          );

          await emitEvent("LOGISTICS_DELAY", {
            postingNumber: row.ozon_posting_number,
            purchaseId: row.id,
            hours: String(Math.round(hours)),
            amountCny: String(row.total_amount_cny),
          });
          result.alerted++;
        }
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, purchaseId: row.id }, "Logistics poll error for purchase");
    }
  }

  return result;
}

// ---- Scheduled Job Wrapper ----

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export function startLogisticsPolling(): void {
  if (pollingTimer) return;

  // Run immediately then on interval
  pollLogistics().then((r) => {
    logger.info(r, "Initial logistics poll complete");
  }).catch((err) => {
    logger.error({ err }, "Initial logistics poll failed");
  });

  pollingTimer = setInterval(() => {
    pollLogistics().then((r) => {
      if (r.checked > 0 || r.alerted > 0) {
        logger.info(r, "Logistics poll cycle");
      }
    }).catch((err) => {
      logger.error({ err }, "Logistics poll cycle failed");
    });
  }, POLL_INTERVAL_MS);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Logistics polling started");
}

export function stopLogisticsPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

export function getForwarderConfig(): FreightForwarderConfig {
  return { ...forwarderConfig };
}
