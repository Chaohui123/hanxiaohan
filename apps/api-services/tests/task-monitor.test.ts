// Route tests for task-monitor.route.ts — supertest + real in-memory SQLite + real TaskQueue
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type BetterSqlite3 from "better-sqlite3";
import { createSqliteTestDb } from "./helpers/test-db.js";

// ---- Hoisted mock state (shared with vi.mock factories) ----
const state = vi.hoisted(() => {
  let dbAvailable = true;
  return {
    isDbAvailable: () => dbAvailable,
    setDbAvailable: (v: boolean) => {
      dbAvailable = v;
    },
    retryDeadLettersFn: vi.fn(),
    writeToDeadLetterFn: vi.fn(),
  };
});

vi.mock("../src/db/connection.js", () => ({
  // Deferred access: `sqlite` below is initialized before any test runs.
  getDb: async () => (state.isDbAvailable() ? sqlite.adapter : null),
  serializedWrite: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../src/services/dead-letter.js", () => ({
  retryDeadLetters: state.retryDeadLettersFn,
  writeToDeadLetter: state.writeToDeadLetterFn,
}));

import { createTaskMonitorRouter } from "../src/routes/task-monitor.route.js";
import { TaskQueue } from "../src/db/task-queue.js";

// ---- Real in-memory SQLite DB — schema mirrors data/onzo.db ----
const sqlite = createSqliteTestDb();

sqlite.db.exec(`
  CREATE TABLE task_queue (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    payload_json TEXT,
    correlation_id TEXT,
    store_id TEXT NOT NULL DEFAULT 'store_1',
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    priority INTEGER DEFAULT 0
  );
  CREATE TABLE failed_tasks (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    payload_json TEXT,
    error_message TEXT,
    status TEXT DEFAULT 'pending_retry',
    correlation_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    retry_count INTEGER DEFAULT 0
  );
  CREATE TABLE listing_records (
    id TEXT PRIMARY KEY,
    source_url TEXT,
    status TEXT NOT NULL,
    draft_id TEXT,
    ozon_product_id INTEGER,
    correlation_id TEXT,
    result_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function makeApp(taskQueue: TaskQueue) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = "test-correlation-id";
    next();
  });
  app.use("/api/task", createTaskMonitorRouter(taskQueue));
  return app;
}

/** Direct row lookup for asserting DB side effects. */
function getRowById<T>(table: "task_queue" | "failed_tasks" | "listing_records", id: string): T | undefined {
  return sqlite.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as T | undefined;
}

function seedRows(db: BetterSqlite3.Database) {
  const insertTask = db.prepare(
    `INSERT INTO task_queue
       (id, type, status, store_id, correlation_id, payload_json, error_message, retry_count, max_retries, priority, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTask.run("tq-1", "listing", "queued", "store_1", "c1", '{"url":"https://detail.1688.com/offer/1.html"}', null, 0, 3, 0, "2026-07-18 01:00:00", null, null);
  insertTask.run("tq-2", "ocr", "failed", "store_2", "c2", "{}", "ocr timeout", 1, 3, 0, "2026-07-18 02:00:00", null, "2026-07-18 02:01:00");
  insertTask.run("tq-3", "listing", "done", "store_1", "c3", "{}", null, 0, 3, 1, "2026-07-18 03:00:00", null, "2026-07-18 03:05:00");

  const insertFailed = db.prepare(
    `INSERT INTO failed_tasks
       (id, store_id, task_type, payload_json, error_message, status, correlation_id, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertFailed.run("dl-1", "store_1", "create_draft", '{"sku":1}', "api_error:Ozon API error 500", "pending_retry", "d1", 1, "2026-07-18 04:00:00", "2026-07-18 04:00:00");
  insertFailed.run("dl-2", "store_2", "listing", "{}", "validation:missing title", "permanent_failure", "d2", 3, "2026-07-18 05:00:00", "2026-07-18 05:00:00");
  insertFailed.run("dl-3", "store_1", "upload_image", "{}", "network:fetch failed", "retried", "d3", 2, "2026-07-18 06:00:00", "2026-07-18 06:00:00");

  const insertListing = db.prepare(
    `INSERT INTO listing_records
       (id, source_url, status, draft_id, ozon_product_id, correlation_id, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertListing.run("lr-1", "https://detail.1688.com/offer/11.html", "done", "draft-1", 123, "l1", null, "2026-07-18 07:00:00");
  insertListing.run("lr-2", "https://detail.1688.com/offer/22.html", "failed", null, null, "l2", null, "2026-07-18 08:00:00");
}

beforeEach(() => {
  sqlite.db.exec("DELETE FROM task_queue; DELETE FROM failed_tasks; DELETE FROM listing_records;");
  state.setDbAvailable(true);
  state.retryDeadLettersFn.mockReset().mockResolvedValue({ retried: 2, failed: 1, total: 3 });
  state.writeToDeadLetterFn.mockReset().mockResolvedValue("new-dead-letter-id");
  seedRows(sqlite.db);
});

describe("GET /api/task/queue/stats", () => {
  it("returns DB-aggregated counts plus dead-letter pending", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/queue/stats");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ queued: 1, processing: 0, done: 1, failed: 1, total: 3, deadLetterPending: 1 });
    expect(typeof res.body.data.maxConcurrency).toBe("number");
  });

  it("falls back to in-memory stats when DB unavailable", async () => {
    state.setDbAvailable(false);
    const tq = new TaskQueue();
    await tq.enqueue({ type: "listing", payload: {}, correlationId: "c-mem" });
    const res = await request(makeApp(tq)).get("/api/task/queue/stats");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ queued: 1, total: 1, deadLetterPending: 0 });
  });
});

describe("GET /api/task/queue", () => {
  it("lists tasks mapped to camelCase DTOs", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/queue");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    const first = res.body.data[0];
    expect(first).toHaveProperty("storeId");
    expect(first).toHaveProperty("retryCount");
    expect(first).toHaveProperty("maxRetries");
    expect(typeof first.payload).toBe("object");
  });

  it("filters by status and storeId", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/queue?status=failed&storeId=store_2");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe("tq-2");
  });

  it("binds filter params — status/storeId/type actually narrow the result", async () => {
    // tq-2 is the only failed task and belongs to store_2, so store_1 must match nothing
    const none = await request(makeApp(new TaskQueue())).get("/api/task/queue?status=failed&storeId=store_1");
    expect(none.status).toBe(200);
    expect(none.body.count).toBe(0);

    const byType = await request(makeApp(new TaskQueue())).get("/api/task/queue?type=ocr");
    expect(byType.status).toBe(200);
    expect(byType.body.count).toBe(1);
    expect(byType.body.data[0].id).toBe("tq-2");
  });

  it("binds the limit param and keeps created_at DESC order", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/queue?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.data.map((t: { id: string }) => t.id)).toEqual(["tq-3", "tq-2"]);
  });

  it("rejects invalid limit", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/queue?limit=0");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/task/failed", () => {
  it("returns actionable dead letters by default (excludes retried)", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/failed");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const ids = res.body.data.map((r: Record<string, unknown>) => r.id);
    expect(ids).not.toContain("dl-3");
  });

  it("exposes dual-casing fields and parsed category", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/failed");
    const dl1 = res.body.data.find((r: Record<string, unknown>) => r.id === "dl-1");
    expect(dl1.taskType).toBe("create_draft");
    expect(dl1.task_type).toBe("create_draft");
    expect(dl1.errorMessage).toContain("api_error");
    expect(dl1.error_message).toBe(dl1.errorMessage);
    expect(dl1.category).toBe("api_error");
    expect(dl1.retryCount).toBe(1);
    expect(dl1.retry_count).toBe(1);
    expect(dl1.maxRetries).toBe(3);
    expect(dl1.payload).toEqual({ sku: 1 });
  });

  it("supports status=all and storeId filter", async () => {
    const all = await request(makeApp(new TaskQueue())).get("/api/task/failed?status=all");
    expect(all.body.count).toBe(3);
    const store2 = await request(makeApp(new TaskQueue())).get("/api/task/failed?storeId=store_2");
    expect(store2.body.count).toBe(1);
    expect(store2.body.data[0].storeId).toBe("store_2");
  });
});

describe("POST /api/task/failed", () => {
  it("records an external failure notification into dead letter", async () => {
    const res = await request(makeApp(new TaskQueue()))
      .post("/api/task/failed")
      .send({ error: { message: "pipeline exploded" }, source: "n8n-auto-publish" });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("new-dead-letter-id");
    expect(state.writeToDeadLetterFn).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "n8n-auto-publish", errorMessage: "pipeline exploded" })
    );
  });

  it("rejects missing error field", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/failed").send({ source: "n8n" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/task/retry/:id", () => {
  it("retries a task present in the in-memory queue", async () => {
    const tq = new TaskQueue();
    const task = await tq.enqueue({ type: "listing", payload: {}, correlationId: "c-retry" });
    await tq.markFailed(task.id, "boom");

    const res = await request(makeApp(tq)).post(`/api/task/retry/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: task.id, source: "task_queue", status: "queued", retryCount: 1 });
  });

  it("retries a failed task found only in task_queue table", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/retry/tq-2");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "tq-2", source: "task_queue", status: "queued", retryCount: 2 });
    expect(getRowById<{ status: string }>("task_queue", "tq-2")?.status).toBe("queued");
  });

  it("marks a dead-letter entry pending_retry", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/retry/dl-2");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "dl-2", source: "dead_letter", status: "pending_retry" });
    expect(getRowById<{ status: string }>("failed_tasks", "dl-2")?.status).toBe("pending_retry");
  });

  it("refuses to retry a done task", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/retry/tq-3");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TASK_NOT_RETRYABLE");
  });

  it("returns 404 for unknown task id", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/retry/no-such-id");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TASK_NOT_FOUND");
  });
});

describe("POST /api/task/deadletter/retry-batch", () => {
  it("delegates category-filtered retry to dead-letter service", async () => {
    const res = await request(makeApp(new TaskQueue()))
      .post("/api/task/deadletter/retry-batch")
      .send({ filterType: "api_error" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ retried: 2, failed: 1, total: 3 });
    expect(state.retryDeadLettersFn).toHaveBeenCalledWith({ filterCategory: "api_error", storeId: undefined, limit: 50 });
  });

  it("maps all/all_retryable to no category filter", async () => {
    await request(makeApp(new TaskQueue())).post("/api/task/deadletter/retry-batch").send({ filterType: "all_retryable" });
    expect(state.retryDeadLettersFn).toHaveBeenCalledWith({ filterCategory: undefined, storeId: undefined, limit: 50 });
  });

  it("accepts an empty body", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/deadletter/retry-batch").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
  });

  it("retries specific taskIds against the dead-letter table", async () => {
    const res = await request(makeApp(new TaskQueue()))
      .post("/api/task/deadletter/retry-batch")
      .send({ taskIds: ["dl-1", "dl-3", "missing"] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ retried: 1, failed: 2, total: 3 });
    expect(getRowById<{ status: string }>("failed_tasks", "dl-1")?.status).toBe("retrying");
    expect(state.retryDeadLettersFn).not.toHaveBeenCalled();
  });
});

describe("/api/task/listings", () => {
  it("GET returns listing history as camelCase array", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/listings");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.data[0]).toMatchObject({ id: "lr-2", sourceUrl: "https://detail.1688.com/offer/22.html", status: "failed" });
    expect(res.body.data[1]).toMatchObject({ id: "lr-1", draftId: "draft-1", ozonProductId: 123 });
    expect(res.body.stats).toBeDefined();
  });

  it("GET filters by status", async () => {
    const res = await request(makeApp(new TaskQueue())).get("/api/task/listings?status=done");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe("lr-1");
  });

  it("POST alias works for the n8n auto-publish workflow", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/listings").send({});
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});
