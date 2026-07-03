import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { syncOrders } from "../src/sync.js";
import { InventoryManager } from "../src/inventory.js";

type SqliteDatabase = Awaited<ReturnType<typeof import("node:sqlite").then>>;

describe("syncOrders integration", () => {
  async function createTempDb() {
    const sqlite = await import("node:sqlite");
    const tmpFile = path.join(os.tmpdir(), `ozon-order-sync-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    const db = new sqlite.DatabaseSync(tmpFile);
    const { initSchema } = await import("../../../apps/api-services/src/db/schema.js");
    await initSchema(db as any);
    return { db, path: tmpFile };
  }

  function createAdapter(db: any) {
    return {
      run: async (sql: string, params?: unknown[]) => {
        const stmt = db.prepare(sql);
        return stmt.run(...(params ?? []));
      },
      all: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const stmt = db.prepare(sql);
        return stmt.all(...(params ?? [])) as T[];
      },
    };
  }

  it("writes new local_orders and deducts inventory exactly once", async () => {
    const { db, path: dbPath } = await createTempDb();
    const adapter = createAdapter(db);

    const inventory = new InventoryManager(adapter);
    await inventory.setStock("SKU123", 200, 10);

    const postings = [
      {
        postingNumber: "P123",
        orderId: 1,
        orderNumber: "O-123",
        status: "awaiting_packaging",
        createdAt: "2026-07-01T12:00:00Z",
        inProcessAt: "",
        products: [],
        price: 100,
        commission: 10,
        payout: 90,
        deliveryMethod: "pickup",
        trackingNumber: "",
        buyerName: "Ivan Ivanov",
        buyerPhone: "+79001234567",
        buyerEmail: "ivan@mail.ru",
      },
    ];

    const client = {
      listPostings: async () => postings,
      listFboPostings: async () => [],
    };

    let processCalls = 0;
    const result = await syncOrders(client as any, {
      client: client as any,
      db: adapter,
      pageSize: 100,
      processPosting: async (posting, { idempotencyKey, db }) => {
        processCalls += 1;
        await db!.run(
          `INSERT INTO local_orders (id, posting_number, order_id, status, created_at, updated_at, buyer_name_masked, buyer_phone_masked, total_price_rub, commission_rub, payout_rub, product_count, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `order-${posting.postingNumber}`,
            posting.postingNumber,
            posting.orderId,
            posting.status,
            posting.createdAt,
            posting.createdAt,
            posting.buyerName,
            posting.buyerPhone,
            posting.price,
            posting.commission,
            posting.payout,
            posting.products.length,
            JSON.stringify(posting),
          ]
        );

        const deductResult = await inventory.deduct(posting.postingNumber, [
          { offerId: "SKU123", sku: 200, quantity: 2 },
        ]);
        expect(deductResult.success).toBe(true);
      },
    });

    expect(result.total).toBe(1);
    expect(processCalls).toBe(1);

    const rows = await adapter.all<{ posting_number: string; order_id: number; status: string }>(
      "SELECT posting_number, order_id, status FROM local_orders WHERE posting_number = ?",
      ["P123"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("awaiting_packaging");

    const stockRow = await adapter.all<{ stock_available: number; stock_reserved: number }>(
      "SELECT stock_available, stock_reserved FROM inventory WHERE offer_id = ? AND sku = ?",
      ["SKU123", 200]
    );
    expect(stockRow[0]?.stock_available).toBe(8);
    expect(stockRow[0]?.stock_reserved).toBe(2);

    const movementRows = await adapter.all<{ posting_number: string; quantity: number; type: string }>(
      "SELECT posting_number, quantity, type FROM stock_movements WHERE posting_number = ?",
      ["P123"]
    );
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0].type).toBe("deduct");
    expect(movementRows[0].quantity).toBe(-2);

    // Run a second sync to ensure idempotent skip on existing local_orders
    const secondResult = await syncOrders(client as any, {
      client: client as any,
      db: adapter,
      pageSize: 100,
      processPosting: async () => {
        throw new Error("Should not process duplicate posting");
      },
    });

    expect(secondResult.total).toBe(0);
    expect(secondResult.errors).toHaveLength(0);

    // cleanup file if created
    db.close();
    await import("node:fs/promises").then((fs) => fs.unlink(dbPath));
  });
});
