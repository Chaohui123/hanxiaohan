// ============================================================
// Ozon Webhook Registration Script
// Usage: npx tsx scripts/setup-webhook.ts
//
// Registers ONZO's webhook URL with Ozon so Ozon pushes
// order status changes (created, delivered, cancelled) to us.
// ============================================================

import "dotenv/config";

// ---- Config ----
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const CLIENT_ID = process.env.OZON_CLIENT_IDS || "";
const API_KEY = process.env.OZON_API_KEYS || "";
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || "";

if (!CLIENT_ID || !API_KEY) {
  console.error("ERROR: OZON_CLIENT_IDS and OZON_API_KEYS must be set in .env");
  process.exit(1);
}

if (!PUBLIC_DOMAIN) {
  console.error("ERROR: PUBLIC_DOMAIN must be set in .env (e.g. onzo.example.com)");
  process.exit(1);
}

const WEBHOOK_URL = `https://${PUBLIC_DOMAIN}/api/webhook/ozon`;

// ---- Types ----
interface OzonWebhookSubscription {
  url: string;
  event_types: string[];
  active: boolean;
}

interface OzonApiError {
  code: number;
  message: string;
}

// ---- Main ----
async function main() {
  console.log("ONZO Webhook Setup");
  console.log("  Ozon API:", OZON_API_BASE);
  console.log("  Client ID:", CLIENT_ID);
  console.log("  Webhook URL:", WEBHOOK_URL);
  console.log("");

  // Step 1: List existing webhooks
  console.log("Step 1: Checking existing webhooks...");
  const existing = await listWebhooks();
  console.log(`  Found ${existing.length} existing webhook(s)`);

  // Check if our URL is already registered
  const alreadyRegistered = existing.find((w: { url: string }) => w.url === WEBHOOK_URL);
  if (alreadyRegistered) {
    console.log(`  Webhook already registered: ${WEBHOOK_URL}`);
    console.log(`  Active: ${alreadyRegistered.active}`);
    if (!alreadyRegistered.active) {
      console.log("  Updating to active...");
      await updateWebhook(WEBHOOK_URL, true);
    }
  } else {
    // Step 2: Register new webhook
    console.log("Step 2: Registering new webhook...");
    const result = await registerWebhook(WEBHOOK_URL);
    if (result) {
      console.log("  Success! Webhook registered.");
      console.log(`  Ozon will push to: ${WEBHOOK_URL}`);
      console.log("");
      console.log("  Event types subscribed:");
      console.log("    - order.created         New order placed");
      console.log("    - order.status_changed  Order status updated");
      console.log("    - order.delivered       Order delivered to buyer");
      console.log("    - order.cancelled       Order cancelled");
    }
  }

  // Step 3: Verify
  console.log("");
  console.log("Step 3: Verification");
  console.log("  Your webhook URL: " + WEBHOOK_URL);
  console.log("  Test from Ozon: POST to above URL with HMAC-SHA256 signature");
  console.log("  Check logs: tail -f /tmp/onzo.log | grep Webhook");
  console.log("");
  console.log("Done.");
}

// ---- Ozon API Helpers ----

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OZON_API_BASE}${path}`, {
    method,
    headers: {
      "Client-Id": CLIENT_ID,
      "Api-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json() as T & { error?: OzonApiError };

  if (!res.ok) {
    const err = data as { error?: OzonApiError };
    console.error(`  API Error [${res.status}]:`, err.error?.message || res.statusText);
    throw new Error(`Ozon API error: ${res.status} ${err.error?.message || res.statusText}`);
  }

  return data as T;
}

async function listWebhooks(): Promise<Array<{ url: string; event_types: string[]; active: boolean }>> {
  try {
    const res = await apiRequest<{ result: Array<{ url: string; event_types: string[]; active: boolean }> }>(
      "POST",
      "/v1/webhook/list"
    );
    return res.result || [];
  } catch {
    console.warn("  Warning: Could not list webhooks (API may not support this endpoint). Continuing...");
    return [];
  }
}

async function registerWebhook(url: string): Promise<boolean> {
  try {
    await apiRequest("POST", "/v1/webhook/subscribe", {
      url,
      event_types: [
        "order.created",
        "order.status_changed",
        "order.delivered",
        "order.cancelled",
      ],
    });
    return true;
  } catch (err) {
    console.error("  Failed to register webhook:", (err as Error).message);
    console.error("");
    console.error("  Manual registration:");
    console.error("  1. Go to https://seller.ozon.ru/app/settings/api-keys");
    console.error("  2. Find 'Webhooks' section");
    console.error(`  3. Add URL: ${url}`);
    console.error("  4. Select events: order.created, order.status_changed, order.delivered, order.cancelled");
    return false;
  }
}

async function updateWebhook(url: string, active: boolean): Promise<void> {
  try {
    await apiRequest("POST", "/v1/webhook/update", { url, active });
    console.log("  Webhook updated successfully.");
  } catch {
    console.warn("  Could not update webhook. Try manually in Ozon Seller Dashboard.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
