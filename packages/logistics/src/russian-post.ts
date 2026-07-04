// ============================================================
// Russian Post (Почта России) Logistics Provider
// API: https://otpravka-api.pochta.ru/
// Best for: small/light packages, economy delivery
// ============================================================

import { logger } from "@onzo/logger";
import type { LogisticsProvider, ShipmentRequest, ShipmentResult, TrackingInfo } from "./index.js";

const RUSSIAN_POST_API_BASE = process.env.RUSSIAN_POST_API_BASE || "https://otpravka-api.pochta.ru/1.0";
const RUSSIAN_POST_API_KEY = process.env.RUSSIAN_POST_API_KEY || "";
const RUSSIAN_POST_TOKEN = process.env.RUSSIAN_POST_TOKEN || ""; // Bearer token (alternative to API key)

export class RussianPostProvider implements LogisticsProvider {
  readonly name = "Russian Post";

  isAvailable(): boolean {
    return !!(RUSSIAN_POST_API_KEY || RUSSIAN_POST_TOKEN);
  }

  async createShipment(request: ShipmentRequest): Promise<ShipmentResult> {
    try {
      const headers = this.getHeaders();

      // Russian Post shipment creation payload
      const payload = {
        "address-type-to": "DEFAULT",
        "given-name": request.recipientName || "Customer",
        "phone": request.recipientPhone || "+70000000000",
        "index-to": parseInt(request.address.zipCode) || 101000,
        "mail-category": "ORDER",
        "mail-type": "POSTAL_PARCEL",
        "mass": Math.round(request.package.weightGrams / 1000), // grams → kg
        "order-num": request.postingNumber,
        "sms-notice-recipient": 1,
        "fragile": false,
        "dimension": {
          "height": request.package.heightCm,
          "length": request.package.lengthCm,
          "width": request.package.widthCm,
        },
        "goods": {
          "items": request.package.items.map((item) => ({
            "description": item.name.substring(0, 100),
            "quantity": item.quantity,
            "value": Math.round(item.priceRub * 100), // kopeks
            "mass": Math.round(request.package.weightGrams / request.package.items.length),
          })),
        },
      };

      const res = await fetch(`${RUSSIAN_POST_API_BASE}/user/backlog`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Russian Post API ${res.status}: ${(errBody as { desc?: string }).desc || res.statusText}`);
      }

      const data = await res.json() as {
        "result-ids"?: Array<{ "barcode"?: string }>;
        barcode?: string;
      };

      const trackingNumber = data.barcode || data["result-ids"]?.[0]?.barcode || "";
      const labelUrl = trackingNumber
        ? `${RUSSIAN_POST_API_BASE}/forms/${trackingNumber}/forms`
        : "";

      // Calculate delivery cost
      let costRub = 0;
      try {
        const tariffRes = await fetch(`${RUSSIAN_POST_API_BASE}/tariff`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            "index-from": 101000,
            "index-to": parseInt(request.address.zipCode) || 101000,
            "mail-category": "ORDER",
            "mail-type": "POSTAL_PARCEL",
            "mass": Math.round(request.package.weightGrams / 1000),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (tariffRes.ok) {
          const tariffData = await tariffRes.json() as { "total-rate"?: number; "total-vat"?: number };
          costRub = ((tariffData["total-rate"] || 0) + (tariffData["total-vat"] || 0)) / 100; // kopeks → rubles
        }
      } catch { /* cost is optional */ }

      logger.info({ trackingNumber, postingNumber: request.postingNumber, costRub }, "Russian Post shipment created");
      return {
        success: true,
        trackingNumber,
        labelUrl,
        estimatedDelivery: new Date(Date.now() + 10 * 86400000).toISOString(), // ~10 days
        costRub,
        provider: "Russian Post",
      };
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ postingNumber: request.postingNumber, err: msg }, "Russian Post shipment failed");
      return { success: false, provider: "Russian Post", error: msg };
    }
  }

  async getTrackingInfo(trackingNumber: string): Promise<TrackingInfo> {
    try {
      const res = await fetch(`${RUSSIAN_POST_API_BASE}/tracking/${trackingNumber}`, {
        method: "GET",
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) throw new Error(`Russian Post ${res.status}`);

      const data = await res.json() as {
        "tracking-history-record"?: Array<{
          "operation-date": string;
          "operation-address": string;
          "operation-description": string;
        }>;
      };
      const history = data["tracking-history-record"] || [];
      const lastEvent = history[0];

      return {
        trackingNumber,
        status: lastEvent ? "in_transit" : "unknown",
        statusDescription: lastEvent?.["operation-description"] || "No events",
        lastUpdate: lastEvent?.["operation-date"] || new Date().toISOString(),
        events: history.map((e) => ({
          timestamp: e["operation-date"],
          location: e["operation-address"] || "",
          description: e["operation-description"],
        })),
      };
    } catch (err) {
      return {
        trackingNumber,
        status: "error",
        statusDescription: (err as Error).message,
        lastUpdate: new Date().toISOString(),
        events: [],
      };
    }
  }

  async cancelShipment(trackingNumber: string): Promise<void> {
    try {
      const res = await fetch(`${RUSSIAN_POST_API_BASE}/user/backlog`, {
        method: "DELETE",
        headers: this.getHeaders(),
        body: JSON.stringify({ barcode: trackingNumber }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Russian Post ${res.status}: ${(errBody as { desc?: string }).desc}`);
      }
      logger.info({ trackingNumber }, "Russian Post shipment cancelled");
    } catch (err) {
      logger.error({ trackingNumber, err: (err as Error).message }, "Russian Post cancel failed");
    }
  }

  // ---- Private ----

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (RUSSIAN_POST_TOKEN) {
      headers["Authorization"] = `Bearer ${RUSSIAN_POST_TOKEN}`;
    } else {
      headers["Authorization"] = `AccessToken ${RUSSIAN_POST_API_KEY}`;
    }
    headers["X-User-Authorization"] = `Basic ${RUSSIAN_POST_TOKEN || RUSSIAN_POST_API_KEY}`;
    return headers;
  }
}
