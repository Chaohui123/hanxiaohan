// ============================================================
// Ozon Webhook receiver — POST /api/webhook/ozon
// ============================================================

import { Router } from "express";
import { parseWebhookPayload, handleWebhookEvent, type WebhookPayload } from "@onzo/ozon-order/webhook";
import { getDb } from "../db/connection.js";

const API_SECRET = process.env.OZON_API_KEYS || "";

export function createWebhookRouter(): Router {
  const router = Router();

  router.post("/webhook/ozon", async (req, res) => {
    const rawBodyBuffer = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-ozon-signature"] as string | undefined;

    const dedupStore = {
      async isDuplicate(eventId: string): Promise<boolean> {
        const db = await getDb().catch(() => null);
        if (!db) return false;
        const rows = await db.all("SELECT 1 FROM webhook_events WHERE event_id = ? LIMIT 1", [eventId]);
        return rows.length > 0;
      },
      async markProcessed(eventId: string, meta?: { postingNumber?: string; eventType?: string }): Promise<void> {
        const db = await getDb().catch(() => null);
        if (!db) return;
        await db.run(
          "INSERT OR IGNORE INTO webhook_events (event_id, posting_number, event_type, created_at) VALUES (?, ?, ?, datetime('now'))",
          [eventId, meta?.postingNumber ?? null, meta?.eventType ?? null]
        );
      },
    };

    // Parse + verify + dedup
    const parsed = await parseWebhookPayload(rawBody, signature, API_SECRET, { dedupStore });

    if (!("eventId" in parsed)) {
      // VerificationResult
      res.status(parsed.reason === "Duplicate event" ? 200 : 400).json({
        success: parsed.valid,
        reason: parsed.reason,
        correlationId: req.correlationId,
      });
      return;
    }

    const payload: WebhookPayload = parsed;

    // Handle the event — update local order status
    await handleWebhookEvent(payload, {
      onStatusChanged: async (p) => {
        const db = await getDb().catch(() => null);
        if (!db) return;

        await db.run(
          "UPDATE local_orders SET status = ?, updated_at = datetime('now') WHERE posting_number = ?",
          [p.status, p.postingNumber]
        );
        console.log(`[Webhook] Order ${p.postingNumber} → ${p.status}`);
      },

      onDelivered: async (p) => {
        const db = await getDb().catch(() => null);
        if (!db) return;

        await db.run(
          "UPDATE local_orders SET status = 'delivered', updated_at = datetime('now') WHERE posting_number = ?",
          [p.postingNumber]
        );

        // Confirm inventory delivery
        const { serializedWrite } = await import("../db/connection.js");
        await serializedWrite(async () => {
          const inv = await import("@onzo/ozon-order/inventory");
          const mgr = new inv.InventoryManager(db!);
          await mgr.confirmDelivery(p.postingNumber);
        });

        console.log(`[Webhook] Order ${p.postingNumber} delivered — inventory updated`);
      },

      onCancelled: async (p) => {
        const db = await getDb().catch(() => null);
        if (!db) return;

        await db.run(
          "UPDATE local_orders SET status = 'cancelled', updated_at = datetime('now') WHERE posting_number = ?",
          [p.postingNumber]
        );

        // Restore inventory
        const { serializedWrite } = await import("../db/connection.js");
        await serializedWrite(async () => {
          const inv = await import("@onzo/ozon-order/inventory");
          const mgr = new inv.InventoryManager(db!);
          const m = await db!.all(
            "SELECT offer_id, sku, -quantity as qty FROM stock_movements WHERE posting_number = ? AND type = 'deduct'",
            [p.postingNumber]
          ) as Array<{ offer_id: string; sku: number; qty: number }>;
          if (m.length > 0) {
            await mgr.restore(p.postingNumber, m.map(x => ({ offerId: x.offer_id, sku: x.sku, quantity: x.qty })));
          }
        });

        console.log(`[Webhook] Order ${p.postingNumber} cancelled — inventory restored`);
      },
    });

    res.json({ success: true, eventId: payload.eventId, correlationId: req.correlationId });
  });

  return router;
}
