// Route tests for task-monitor.route.ts — supertest + fake DbAdapter + real TaskQueue
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---- Hoisted fake DB state (shared with vi.mock factories) ----
const state = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const rows = {
    taskQueue: [] as Row[],
    failedTasks: [] as Row[],
    listingRecords: [] as Row[],
  };
  let dbAvailable = true;

  function selectList(all: Row[], sql: string, params: unknown[]): Row[] {
    const values = [...params];
    let out = all;
    if (sql.includes("status != 'retried'")) out = out.filter((r) => r.status !== "retried");
    if (sql.includes("status = ?")) {
      const v = values.shift();
      out = out.filter((r) => r.status === v);
    }
    if (sql.includes("store_id = ?")) {
      const v = values.shift();
      out = out.filter((r) => r.store_id === v);
    }
    if (sql.includes("type = ?")) {
      const v = values.shift();
      out = out.filter((r) => r.type === v);
    }
    const limit = Number(values[values.length - 1] ?? 50);
    return [...out]
      .map((r) => ({ ...r }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  const adapter = {
    exec(): void {},
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      if (sql.startsWith("UPDATE task_queue")) {
        const id = params[params.length - 1];
        const row = rows.taskQueue.find((r) => r.id === id);
        if (!row) return { changes: 0 };
        row.status = "queued";
        row.retry_count = Number(row.retry_count ?? 0) + 1;
        row.error_message = null;
        row.started_at = null;
        row.completed_at = null;
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE failed_tasks")) {
        const id = params[params.length - 1];
        const row = rows.failedTasks.find((r) => r.id === id);
        if (!row) return { changes: 0 };
        if (
          sql.includes("status IN ('pending_retry', 'permanent_failure')") &&
          !["pending_retry", "permanent_failure"].includes(String(row.status))
        ) {
          return { changes: 0 };
        }
        if (sql.includes("'retrying'")) row.status = "retrying";
        else if (sql.includes("'pending_retry'")) row.status = "pending_retry";
        row.retry_count = Number(row.retry_count ?? 0) + 1;
        row.updated_at = new Date().toISOString();
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    async all(sql: string, params: unknown[] = []): Promise<Row[]> {
      if (sql.includes("GROUP BY status")) {
        const counts = new Map<string, number>();
        for (const r of rows.taskQueue) {
          const s = String(r.status);
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        return [...counts.entries()].map(([status, cnt]) => ({ status, cnt }));
      }
      if (sql.includes("COUNT(*)") && sql.includes("failed_tasks")) {
        return [{ cnt: rows.failedTasks.filter((r) => r.status === "pending_retry").length }];
      }
      if (sql.includes("FROM task_queue WHERE id = ?")) {
        return rows.taskQueue.filter((r) => r.id === params[0]).map((r) => ({ ...r }));
      }
      if (sql.includes("FROM failed_tasks WHERE id = ?")) {
        return rows.failedTasks.filter((r) => r.id === params[0]).map((r) => ({ ...r }));
      }
      if (sql.includes("FROM task_queue")) return selectList(rows.taskQueue, sql, params);
      if (sql.includes("FROM failed_tasks")) return selectList(rows.failedTasks, sql, params);
      if (sql.includes("FROM listing_records")) return selectList(rows.listingRecords, sql, params);
      return [];
    },
  };

  return {
    rows,
    adapter,
    isDbAvailable: () => dbAvailable,
    setDbAvailable: (v: boolean) => {
      dbAvailable = v;
    },
    retryDeadLettersFn: vi.fn(),
    writeToDeadLetterFn: vi.fn(),
  };
});

vi.mock("../src/db/connection.js", () => ({
  getDb: async () => (state.isDbAvailable() ? state.adapter : null),
  serializedWrite: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../src/services/dead-letter.js", () => ({
  retryDeadLetters: state.retryDeadLettersFn,
  writeToDeadLetter: state.writeToDeadLetterFn,
}));

import { createTaskMonitorRouter } from "../src/routes/task-monitor.route.js";
import { TaskQueue } from "../src/db/task-queue.js";

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

function seedRows() {
  state.rows.taskQueue.push(
    { id: "tq-1", type: "listing", status: "queued", store_id: "store_1", correlation_id: "c1", payload_json: '{"url":"https://detail.1688.com/offer/1.html"}', error_message: null, retry_count: 0, max_retries: 3, priority: 0, created_at: "2026-07-18 01:00:00", started_at: null, completed_at: null },
    { id: "tq-2", type: "ocr", status: "failed", store_id: "store_2", correlation_id: "c2", payload_json: "{}", error_message: "ocr timeout", retry_count: 1, max_retries: 3, priority: 0, created_at: "2026-07-18 02:00:00", started_at: null, completed_at: "2026-07-18 02:01:00" },
    { id: "tq-3", type: "listing", status: "done", store_id: "store_1", correlation_id: "c3", payload_json: "{}", error_message: null, retry_count: 0, max_retries: 3, priority: 1, created_at: "2026-07-18 03:00:00", started_at: null, completed_at: "2026-07-18 03:05:00" },
  );
  state.rows.failedTasks.push(
    { id: "dl-1", store_id: "store_1", task_type: "create_draft", payload_json: '{"sku":1}', error_message: "api_error:Ozon API error 500", status: "pending_retry", correlation_id: "d1", retry_count: 1, created_at: "2026-07-18 04:00:00", updated_at: "2026-07-18 04:00:00" },
    { id: "dl-2", store_id: "store_2", task_type: "listing", payload_json: "{}", error_message: "validation:missing title", status: "permanent_failure", correlation_id: "d2", retry_count: 3, created_at: "2026-07-18 05:00:00", updated_at: "2026-07-18 05:00:00" },
    { id: "dl-3", store_id: "store_1", task_type: "upload_image", payload_json: "{}", error_message: "network:fetch failed", status: "retried", correlation_id: "d3", retry_count: 2, created_at: "2026-07-18 06:00:00", updated_at: "2026-07-18 06:00:00" },
  );
  state.rows.listingRecords.push(
    { id: "lr-1", source_url: "https://detail.1688.com/offer/11.html", status: "done", draft_id: "draft-1", ozon_product_id: 123, correlation_id: "l1", result_json: null, created_at: "2026-07-18 07:00:00" },
    { id: "lr-2", source_url: "https://detail.1688.com/offer/22.html", status: "failed", draft_id: null, ozon_product_id: null, correlation_id: "l2", result_json: null, created_at: "2026-07-18 08:00:00" },
  );
}

beforeEach(() => {
  state.rows.taskQueue.length = 0;
  state.rows.failedTasks.length = 0;
  state.rows.listingRecords.length = 0;
  state.setDbAvailable(true);
  state.retryDeadLettersFn.mockReset().mockResolvedValue({ retried: 2, failed: 1, total: 3 });
  state.writeToDeadLetterFn.mockReset().mockResolvedValue("new-dead-letter-id");
  seedRows();
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
    expect(state.rows.taskQueue.find((r) => r.id === "tq-2")?.status).toBe("queued");
  });

  it("marks a dead-letter entry pending_retry", async () => {
    const res = await request(makeApp(new TaskQueue())).post("/api/task/retry/dl-2");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "dl-2", source: "dead_letter", status: "pending_retry" });
    expect(state.rows.failedTasks.find((r) => r.id === "dl-2")?.status).toBe("pending_retry");
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
    expect(state.rows.failedTasks.find((r) => r.id === "dl-1")?.status).toBe("retrying");
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
