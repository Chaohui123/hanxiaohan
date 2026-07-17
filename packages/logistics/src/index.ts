// ============================================================
// Logistics Provider Interface + Factory
// Pluggable: CDEK, Russian Post, auto-select by weight/dest
// ============================================================

import { logger } from "@onzo/logger";

// ---- Types ----

export interface ShipmentRequest {
  postingNumber: string;
  /** Recipient name (masked OK — CDEK needs real address) */
  recipientName: string;
  recipientPhone: string;
  /** Delivery address (city, street, zip) */
  address: {
    city: string;
    street: string;
    zipCode: string;
    country?: string;
  };
  /** Package details */
  package: {
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    items: Array<{ name: string; quantity: number; priceRub: number }>;
  };
  /** Preferred delivery type */
  deliveryType?: "courier" | "pickup";
}

export interface ShipmentResult {
  success: boolean;
  trackingNumber?: string;
  labelUrl?: string;
  estimatedDelivery?: string;
  costRub?: number;
  provider: string;
  error?: string;
}

export interface TrackingInfo {
  trackingNumber: string;
  status: string;
  statusDescription: string;
  lastUpdate: string;
  estimatedDelivery?: string;
  events: Array<{ timestamp: string; location: string; description: string }>;
}

// ---- Provider Interface ----

export interface LogisticsProvider {
  readonly name: string;
  /** Create a shipment and get tracking number + label. */
  createShipment(request: ShipmentRequest): Promise<ShipmentResult>;
  /** Get tracking status by tracking number. */
  getTrackingInfo(trackingNumber: string): Promise<TrackingInfo>;
  /** Cancel a shipment. */
  cancelShipment(trackingNumber: string): Promise<void>;
  /** Check if provider is available (API key configured, not rate-limited). */
  isAvailable(): boolean;
}

// ---- Provider Factory ----

export type LogisticsProviderName = "cdek" | "russian_post" | "boxberry" | "auto";
export type LogisticsProviderWeight = { provider: LogisticsProviderName; weight: number };

let defaultProvider: LogisticsProvider | null = null;

/**
 * Get the configured logistics provider.
 * Selection logic:
 *   "cdek" | "russian_post" → explicit provider
 *   "auto" → CDEK (courier) or Russian Post (economy) based on package weight
 */
export async function getLogisticsProvider(): Promise<LogisticsProvider | null> {
  if (defaultProvider) return defaultProvider;

  const providerName = (process.env.LOGISTICS_PROVIDER || "auto") as LogisticsProviderName;

  if (providerName === "cdek") {
    const { CdekProvider } = await import("./cdek.js");
    const p = new CdekProvider();
    if (p.isAvailable()) { defaultProvider = p; return p; }
    logger.warn("CDEK provider not available — check CDEK_CLIENT_ID/CDEK_CLIENT_SECRET");
  }

  if (providerName === "russian_post") {
    const { RussianPostProvider } = await import("./russian-post.js");
    const p = new RussianPostProvider();
    if (p.isAvailable()) { defaultProvider = p; return p; }
    logger.warn("Russian Post provider not available — check RUSSIAN_POST_API_KEY");
  }

  if (providerName === "boxberry") {
    const { BoxberryProvider } = await import("./boxberry.js");
    const p = new BoxberryProvider();
    if (p.isAvailable()) { defaultProvider = p; return p; }
    logger.warn("Boxberry provider not available — check BOXBERRY_API_TOKEN");
  }

  // "auto" or explicit provider failed → try CDEK first, then Boxberry, then Russian Post
  if (providerName === "auto") {
    // Try providers in priority order based on weights if configured
    const weights = parseLogisticsWeights();
    const available: Array<{ provider: LogisticsProvider; weight: number }> = [];

    const { CdekProvider } = await import("./cdek.js");
    const cdek = new CdekProvider();
    if (cdek.isAvailable()) available.push({ provider: cdek, weight: weights["cdek"] ?? 5 });

    const { BoxberryProvider } = await import("./boxberry.js");
    const boxberry = new BoxberryProvider();
    if (boxberry.isAvailable()) available.push({ provider: boxberry, weight: weights["boxberry"] ?? 3 });

    const { RussianPostProvider } = await import("./russian-post.js");
    const rp = new RussianPostProvider();
    if (rp.isAvailable()) available.push({ provider: rp, weight: weights["russian_post"] ?? 2 });

    if (available.length > 0) {
      // Weight-based random selection for multi-carrier load balancing
      const totalWeight = available.reduce((sum, a) => sum + a.weight, 0);
      let roll = Math.random() * totalWeight;
      for (const a of available) {
        roll -= a.weight;
        if (roll <= 0) {
          defaultProvider = a.provider;
          logger.info({ provider: a.provider.name }, "Auto-selected logistics provider (weighted)");
          return a.provider;
        }
      }
      // Fallback to first available
      defaultProvider = available[0]!.provider;
      return available[0]!.provider;
    }
  }

  logger.error("No logistics provider configured. Set LOGISTICS_PROVIDER + API keys in .env");
  return null;
}

/** Parse LOGISTICS_WEIGHTS env var: "70,30" → { cdek: 70, boxberry: 30 } */
function parseLogisticsWeights(): Record<string, number> {
  const raw = process.env.LOGISTICS_WEIGHTS || "";
  if (!raw) return {};
  const weights = raw.split(",").map(Number);
  const names: string[] = ["cdek", "boxberry", "russian_post"];
  const result: Record<string, number> = {};
  for (let i = 0; i < Math.min(weights.length, names.length); i++) {
    if (!isNaN(weights[i]!)) result[names[i]!] = weights[i]!;
  }
  return result;
}

/**
 * Select the best logistics provider for a given shipment request.
 * Simple heuristic: CDEK for heavy/express, Russian Post for light/economy.
 */
export async function selectBestProvider(request: ShipmentRequest): Promise<LogisticsProvider | null> {
  const providerName = (process.env.LOGISTICS_PROVIDER || "auto") as LogisticsProviderName;

  if (providerName !== "auto") {
    return getLogisticsProvider();
  }

  // Auto-select: Russian Post for <2kg, CDEK for heavier
  if (request.package.weightGrams < 2000) {
    const { RussianPostProvider } = await import("./russian-post.js");
    const rp = new RussianPostProvider();
    if (rp.isAvailable()) return rp;
  }

  return getLogisticsProvider();
}
