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

export type LogisticsProviderName = "cdek" | "russian_post" | "auto";

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

  // "auto" or explicit provider failed → try CDEK first, then Russian Post
  if (providerName === "auto") {
    const { CdekProvider } = await import("./cdek.js");
    const cdek = new CdekProvider();
    if (cdek.isAvailable()) {
      defaultProvider = cdek;
      logger.info("Auto-selected CDEK as logistics provider");
      return cdek;
    }

    const { RussianPostProvider } = await import("./russian-post.js");
    const rp = new RussianPostProvider();
    if (rp.isAvailable()) {
      defaultProvider = rp;
      logger.info("Auto-selected Russian Post as logistics provider");
      return rp;
    }
  }

  logger.error("No logistics provider configured. Set LOGISTICS_PROVIDER + API keys in .env");
  return null;
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
