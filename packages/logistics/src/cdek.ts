// ============================================================
// CDEK Logistics Provider — Russian courier delivery
// API: https://api.cdek.ru/v2/
// Auth: OAuth2 client_credentials → Bearer token
// ============================================================

import { logger } from "@onzo/logger";
import type { LogisticsProvider, ShipmentRequest, ShipmentResult, TrackingInfo } from "./index.js";

const CDEK_API_BASE = process.env.CDEK_API_BASE || "https://api.cdek.ru/v2";
const CDEK_CLIENT_ID = process.env.CDEK_CLIENT_ID || "";
const CDEK_CLIENT_SECRET = process.env.CDEK_CLIENT_SECRET || "";

interface CdekToken {
  access_token: string;
  expires_at: number;
}

let tokenCache: CdekToken | null = null;

export class CdekProvider implements LogisticsProvider {
  readonly name = "CDEK";

  isAvailable(): boolean {
    return !!(CDEK_CLIENT_ID && CDEK_CLIENT_SECRET);
  }

  async createShipment(request: ShipmentRequest): Promise<ShipmentResult> {
    try {
      const token = await this.getToken();

      // Build CDEK order payload
      const payload = {
        type: "1", // 1 = online store order
        number: request.postingNumber,
        tariff_code: request.deliveryType === "pickup" ? 234 : 137, // 137=courier, 234=pickup
        sender: {
          company: "ONZO",
          name: "ONZO Store",
        },
        recipient: {
          name: request.recipientName || "Customer",
          phones: [{ number: request.recipientPhone || "+70000000000" }],
        },
        to_location: {
          code: 44, // Moscow (default pickup city)
          address: `${request.address.street}, ${request.address.city}, ${request.address.zipCode}`,
        },
        packages: [{
          number: "1",
          weight: request.package.weightGrams,
          length: request.package.lengthCm,
          width: request.package.widthCm,
          height: request.package.heightCm,
          items: request.package.items.map((item) => ({
            name: item.name,
            ware_key: `SKU-${item.name.substring(0, 20)}`,
            payment: { value: item.priceRub / request.package.items.length },
            cost: item.priceRub / request.package.items.length,
            weight: Math.round(request.package.weightGrams / request.package.items.length),
            amount: item.quantity,
          })),
        }],
      };

      const res = await fetch(`${CDEK_API_BASE}/orders`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`CDEK API ${res.status}: ${(errBody as { errors?: Array<{ message: string }> }).errors?.[0]?.message || res.statusText}`);
      }

      const data = await res.json() as {
        entity?: { uuid?: string; cdek_number?: string };
        requests?: Array<{ request_uuid?: string; state?: string }>;
      };

      const trackingNumber = data.entity?.cdek_number || data.requests?.[0]?.request_uuid || "";
      const orderUuid = data.entity?.uuid || data.requests?.[0]?.request_uuid || "";

      // Get label/barcode
      let labelUrl = "";
      if (orderUuid) {
        try {
          const labelRes = await fetch(`${CDEK_API_BASE}/print/barcodes/${orderUuid}`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (labelRes.ok) {
            labelUrl = `${CDEK_API_BASE}/print/barcodes/${orderUuid}`;
          }
        } catch { /* label optional */ }
      }

      logger.info({ trackingNumber, postingNumber: request.postingNumber }, "CDEK shipment created");
      return {
        success: true,
        trackingNumber,
        labelUrl,
        estimatedDelivery: new Date(Date.now() + 7 * 86400000).toISOString(), // ~7 days
        costRub: 0, // CDEK returns cost in tariff calculation
        provider: "CDEK",
      };
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ postingNumber: request.postingNumber, err: msg }, "CDEK shipment failed");
      return { success: false, provider: "CDEK", error: msg };
    }
  }

  async getTrackingInfo(trackingNumber: string): Promise<TrackingInfo> {
    try {
      const token = await this.getToken();
      const res = await fetch(`${CDEK_API_BASE}/orders?cdek_number=${trackingNumber}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) throw new Error(`CDEK ${res.status}`);

      const data = await res.json() as {
        entity?: {
          statuses?: Array<{ code: string; name: string; date_time: string; city?: string }>;
        };
      };
      const statuses = data.entity?.statuses || [];
      const lastStatus = statuses[0];

      return {
        trackingNumber,
        status: lastStatus?.code || "unknown",
        statusDescription: lastStatus?.name || "No status",
        lastUpdate: lastStatus?.date_time || new Date().toISOString(),
        events: statuses.map((s) => ({
          timestamp: s.date_time,
          location: s.city || "",
          description: s.name,
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
      const token = await this.getToken();
      const res = await fetch(`${CDEK_API_BASE}/orders/${trackingNumber}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`CDEK ${res.status}: ${(errBody as { errors?: Array<{ message: string }> }).errors?.[0]?.message}`);
      }
      logger.info({ trackingNumber }, "CDEK shipment cancelled");
    } catch (err) {
      logger.error({ trackingNumber, err: (err as Error).message }, "CDEK cancel failed");
    }
  }

  // ---- Private ----

  private async getToken(): Promise<string> {
    if (tokenCache && tokenCache.expires_at > Date.now() + 60_000) {
      return tokenCache.access_token;
    }

    const res = await fetch(`${CDEK_API_BASE}/oauth/token?grant_type=client_credentials&client_id=${CDEK_CLIENT_ID}&client_secret=${CDEK_CLIENT_SECRET}`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`CDEK auth failed: ${res.status}`);

    const data = await res.json() as { access_token: string; expires_in: number };
    tokenCache = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in * 1000),
    };
    return tokenCache.access_token;
  }
}
