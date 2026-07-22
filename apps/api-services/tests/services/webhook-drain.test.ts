// Webhook drain — async consumer for ozon_webhook_log
// Real in-memory SQLite (no string-matching fake DB), order-processor mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSqliteTestDb } from "../helpers/test-db.js";

const mockHandleWebhookEvent = vi.fn().mockResolvedValue(undefined);
const mockProcessNewOrder = vi.fn().mockResolvedValue(undefined);
const mockProcessStatusChange = vi.fn().mockResolvedValue(undefined);
const mockProcessCancelledOrder = vi.fn().mockResolvedValue(undefined);
const mockWriteToDeadLetter = vi.fn().mockResolvedValue("dl-1");

vi.mock("@onzo/ozon-order/webhook", () => ({
  handleWebhookEvent: (...args: unknown[]) => mockHandleWebhookEvent(...args),
}));

vi.mock("../../src/services/order-processor.js", () => ({
  processNewOrder: (...args: unknown[]) => mockProcessNewOrder(...args),
  processStatusChange: (...args: unknown[]) => mockProcessStatusChange(...args),
  processCancelledOrder: (...args: unknown[]) => mockProcessCancelledOrder(...args),
}));

vi.mock("../../src/services/dead-letter.js", () => ({
  writeToDeadLetter: (...args: unknown[]) => mockWriteToDeadLetter(...args),
}));

const DDL = `
CREATE TABLE ozon_webhook_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  posting_number TEXT,
  order_id INTEGER,
  status TEXT,
  signature TEXT,
  client_ip TEXT,
  payload_json TEXT NOT NULL,
  process_status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
)`;

function seed(adapter: { run: (sql: string, params?: unknown[]) => Promise<unknown> }, rows: Array<Record<string, unknown>>): Promise<unknown>[] {
  return rows.map((r) =>
    adapter.run(
      `INSERT INTO ozon_webhook_log (id, event_id, event_type, posting_number, order_id, status, payload_json, process_status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.event_id, r.event_type, r.posting_number, r.order_id, r.status, r.payload_json, r.process_status ?? "queued", r.received_at ?? "2026-07-22 01:00:00"]
    )
  );
}

let dbCtx: ReturnType<typeof createSqliteTestDb>;

vi.mock("../../src/db/connection.js", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(dbCtx.adapter)),
  serializedWrite: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));

describe("webhook-drain", () => {
  beforeEach(async () => {
    dbCtx = createSqliteTestDb();
    await dbCtx.adapter.exec(DDL);
    vi.clearAllMocks();
    // The mocked handleWebhookEvent must actually invoke the action callbacks,
    // otherwise downstream order-processor calls never happen.
    mockHandleWebhookEvent.mockImplementation(async (_payload: unknown, actions: { onStatusChanged?: (p: unknown) => Promise<void> }) => {
      await actions.onStatusChanged?.(_payload);
    });
  });

  it("processes queued events to done and calls order-processor", async () => {
    await seed(dbCtx.adapter, [
      { id: "owl-1", event_id: "evt-1", event_type: "order.status_changed", posting_number: "PN-1", order_id: 100, status: "delivering", payload_json: "{}" },
    ]);
    const { drainOzonWebhookLog } = await import("../../src/services/webhook-drain.js");
    const result = await drainOzonWebhookLog();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockHandleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockProcessStatusChange).toHaveBeenCalledWith("PN-1", "delivering");

    const row = dbCtx.db.prepare("SELECT process_status, processed_at FROM ozon_webhook_log WHERE id = 'owl-1'").get() as { process_status: string; processed_at: string | null };
    expect(row.process_status).toBe("done");
    expect(row.processed_at).not.toBeNull();
  });

  it("order.created additionally triggers processNewOrder", async () => {
    await seed(dbCtx.adapter, [
      { id: "owl-2", event_id: "evt-2", event_type: "order.created", posting_number: "PN-2", order_id: 200, status: "awaiting_deliver", payload_json: "{}" },
    ]);
    const { drainOzonWebhookLog } = await import("../../src/services/webhook-drain.js");
    await drainOzonWebhookLog();
    expect(mockProcessNewOrder).toHaveBeenCalledTimes(1);
    expect(dbCtx.db.prepare("SELECT process_status FROM ozon_webhook_log WHERE id = 'owl-2'").get()).toEqual({ process_status: "done" });
  });

  it("marks failed events with error and writes dead letter", async () => {
    mockHandleWebhookEvent.mockRejectedValueOnce(new Error("inventory deduction exploded"));
    await seed(dbCtx.adapter, [
      { id: "owl-3", event_id: "evt-3", event_type: "order.cancelled", posting_number: "PN-3", order_id: 300, status: "cancelled", payload_json: "{}" },
    ]);
    const { drainOzonWebhookLog } = await import("../../src/services/webhook-drain.js");
    const result = await drainOzonWebhookLog();

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(mockWriteToDeadLetter).toHaveBeenCalledTimes(1);

    const row = dbCtx.db.prepare("SELECT process_status, error FROM ozon_webhook_log WHERE id = 'owl-3'").get() as { process_status: string; error: string };
    expect(row.process_status).toBe("failed");
    expect(row.error).toContain("inventory deduction exploded");
  });

  it("optimistic lock prevents double consumption of processing rows", async () => {
    await seed(dbCtx.adapter, [
      { id: "owl-4", event_id: "evt-4", event_type: "order.status_changed", posting_number: "PN-4", order_id: 400, status: "delivering", payload_json: "{}", process_status: "processing" },
      { id: "owl-5", event_id: "evt-5", event_type: "order.status_changed", posting_number: "PN-5", order_id: 500, status: "delivering", payload_json: "{}", process_status: "done" },
    ]);
    const { drainOzonWebhookLog } = await import("../../src/services/webhook-drain.js");
    const result = await drainOzonWebhookLog();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockHandleWebhookEvent).not.toHaveBeenCalled();
  });

  it("processes at most `limit` rows per cycle, oldest first", async () => {
    await seed(dbCtx.adapter, [
      { id: "owl-b", event_id: "evt-b", event_type: "order.status_changed", posting_number: "PN-b", order_id: 2, status: "delivering", payload_json: "{}", received_at: "2026-07-22 01:02:00" },
      { id: "owl-a", event_id: "evt-a", event_type: "order.status_changed", posting_number: "PN-a", order_id: 1, status: "delivering", payload_json: "{}", received_at: "2026-07-22 01:01:00" },
      { id: "owl-c", event_id: "evt-c", event_type: "order.status_changed", posting_number: "PN-c", order_id: 3, status: "delivering", payload_json: "{}", received_at: "2026-07-22 01:03:00" },
    ]);
    const { drainOzonWebhookLog } = await import("../../src/services/webhook-drain.js");
    const result = await drainOzonWebhookLog(2);

    expect(result.processed).toBe(2);
    const done = dbCtx.db.prepare("SELECT id FROM ozon_webhook_log WHERE process_status = 'done' ORDER BY id").all() as Array<{ id: string }>;
    expect(done.map((r) => r.id)).toEqual(["owl-a", "owl-b"]);
    expect(dbCtx.db.prepare("SELECT process_status FROM ozon_webhook_log WHERE id = 'owl-c'").get()).toEqual({ process_status: "queued" });
  });
});
