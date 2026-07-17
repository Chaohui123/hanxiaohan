// ============================================================
// Boxberry Logistics Provider — Russian delivery API
// API docs: https://help.boxberry.ru/pages/viewpage.action?pageId=4502325
// ============================================================

import type { LogisticsProvider, ShipmentRequest, ShipmentResult, TrackingInfo } from "./index.js";
import { logger } from "@onzo/logger";

const BOXBERRY_TOKEN = process.env.BOXBERRY_API_TOKEN || "";
const BOXBERRY_BASE = process.env.BOXBERRY_API_BASE || "https://api.boxberry.ru/json.php";

interface BoxberryDeliveryCost {
  price: number;
  price_base: number;
  price_service: number;
  delivery_period: number;
}

interface BoxberryCreateResponse {
  track?: string;
  label?: string;
  err?: string;
}

interface BoxberryStatusResponse {
  statuses?: Array<{
    track: string;
    label: string;
    status: string;
    status_text: string;
    date: string;
    city: string;
  }>;
  err?: string;
}

export class BoxberryProvider implements LogisticsProvider {
  readonly name = "boxberry";

  isAvailable(): boolean {
    return !!BOXBERRY_TOKEN && !BOXBERRY_TOKEN.includes("CHANGE_ME");
  }

  async createShipment(request: ShipmentRequest): Promise<ShipmentResult> {
    if (!this.isAvailable()) {
      return { success: false, provider: this.name, error: "Boxberry API token not configured" };
    }

    try {
      // Step 1: Calculate delivery cost
      const cost = await this.getDeliveryCost(request);
      if (!cost) {
        return { success: false, provider: this.name, error: "Failed to calculate delivery cost" };
      }

      // Step 2: Create the parcel
      const body = {
        token: BOXBERRY_TOKEN,
        method: "ParselCreate",
        sdata: {
          updateByTrack: request.postingNumber,
          order_id: request.postingNumber,
          // Sender defaults — these should come from store config in production
          vid: "1", // Pickup type: 1 = from Boxberry office, 2 = courier pickup
          // Recipient info
          shop: {
            name: request.recipientName || "",
            phone: request.recipientPhone || "",
            addressp: `${request.address?.street || ""}, ${request.address?.city || ""}, ${request.address?.zipCode || ""}`,
          },
          // Package info
          items: request.package.items.map((item) => ({
            id: item.name,
            name: item.name,
            UnitName: "шт",
            price: Math.round(item.priceRub),
            quantity: item.quantity,
          })),
          // Dimensions (convert cm to dm for Boxberry)
          weights: {
            weight: Math.max(1, Math.round(request.package.weightGrams / 100) / 10), // grams → kg with 1 decimal
          },
        },
      };

      const resp = await fetch(BOXBERRY_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      const data = (await resp.json()) as BoxberryCreateResponse & { err?: string };

      if (data.err) {
        return { success: false, provider: this.name, error: data.err };
      }

      const tracking: string = data.track || `BW-${request.postingNumber.slice(-10)}`;

      logger.info({ tracking, postingNumber: request.postingNumber }, "Boxberry shipment created");

      return {
        success: true,
        provider: this.name,
        trackingNumber: tracking,
        labelUrl: data.label || undefined,
        estimatedDelivery: cost.delivery_period
          ? new Date(Date.now() + cost.delivery_period * 86_400_000).toISOString()
          : undefined,
        costRub: cost.price,
      };
    } catch (err) {
      return {
        success: false,
        provider: this.name,
        error: (err as Error).message,
      };
    }
  }

  async getTrackingInfo(trackingNumber: string): Promise<TrackingInfo> {
    try {
      const body = {
        token: BOXBERRY_TOKEN,
        method: "ListStatuses",
        sdata: { track: trackingNumber },
      };

      const resp = await fetch(BOXBERRY_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const data = (await resp.json()) as BoxberryStatusResponse;

      if (data.err || !data.statuses?.length) {
        return {
          trackingNumber,
          status: "unknown",
          statusDescription: data.err || "No tracking data",
          lastUpdate: new Date().toISOString(),
          events: [],
        };
      }

      const latest = data.statuses[data.statuses.length - 1]!;

      return {
        trackingNumber,
        status: latest.status,
        statusDescription: latest.status_text || latest.status,
        lastUpdate: latest.date,
        events: data.statuses.map((s) => ({
          timestamp: s.date,
          location: s.city || "",
          description: s.status_text || s.status,
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
      const body = {
        token: BOXBERRY_TOKEN,
        method: "ParselDel",
        sdata: { track: trackingNumber },
      };

      await fetch(BOXBERRY_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.warn({ trackingNumber, err: (err as Error).message }, "Boxberry: cancel shipment failed");
    }
  }

  // ---- Private ----

  private async getDeliveryCost(request: ShipmentRequest): Promise<BoxberryDeliveryCost | null> {
    try {
      const body = {
        token: BOXBERRY_TOKEN,
        method: "DeliveryCosts",
        sdata: {
          weight: Math.max(0.1, request.package.weightGrams / 1000), // grams → kg
          // Default destination: Moscow (to receiver — Boxberry calculates from pickup point)
          targetstart: request.address?.zipCode || "101000",
          ordersum: request.package.items.reduce((sum, i) => sum + i.priceRub * i.quantity, 0),
          pay_sum: 0, // prepaid by sender
        },
      };

      const resp = await fetch(BOXBERRY_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      const data = (await resp.json()) as BoxberryDeliveryCost & { err?: string };
      if (data.err) return null;
      return data;
    } catch {
      return null;
    }
  }
}
