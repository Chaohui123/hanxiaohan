import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  triggerMarketPoll: vi.fn(),
  taskLogs: [
    {
      id: "task-market-1",
      type: "market_poll",
      startedAt: "2026-10-24T02:00:00.000Z",
      completedAt: "2026-10-24T02:01:00.000Z",
      status: "completed",
      summary: "market poll completed",
    },
  ],
}));

vi.mock("../src/task/schedule-task.js", () => ({
  triggerMarketPoll: state.triggerMarketPoll,
  taskLogs: state.taskLogs,
}));

import { createTaskTriggerRouter } from "../src/routes/task.route.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = "test-correlation-id";
    next();
  });
  app.use("/api/task", createTaskTriggerRouter());
  app.use("/api/v1/task", createTaskTriggerRouter());
  return app;
}

beforeEach(() => {
  state.triggerMarketPoll.mockReset().mockResolvedValue(state.taskLogs[0]);
});

describe("legacy price task shutdown", () => {
  it.each(["/api/task/run-price", "/api/v1/task/run-price"])(
    "POST %s returns 410 without running another task",
    async (path) => {
      const res = await request(makeApp()).post(path);

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: "LEGACY_PRICE_TASK_DISABLED",
          message: expect.stringContaining("decision-engine"),
        },
        correlationId: "test-correlation-id",
      });
      expect(state.triggerMarketPoll).not.toHaveBeenCalled();
    }
  );

  it("does not import, export, or schedule the legacy price task", () => {
    const source = readFileSync(new URL("../src/task/schedule-task.ts", import.meta.url), "utf8");

    expect(source).not.toContain("daily-price-graph");
    expect(source).not.toContain("triggerPriceAdjust");
    expect(source).not.toContain("PRICE_TASK_CRON");
    expect(source).toContain('schedule(process.env.MARKET_TASK_CRON || "0 2 * * *"');
  });
});

describe("remaining task routes", () => {
  it.each(["/api/task/run-market", "/api/v1/task/run-market"])(
    "POST %s still triggers the market poll",
    async (path) => {
      const res = await request(makeApp()).post(path);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { id: "task-market-1" } });
      expect(state.triggerMarketPoll).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["/api/task/logs", "/api/v1/task/logs"])("GET %s still returns task logs", async (path) => {
    const res = await request(makeApp()).get(path);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [{ id: "task-market-1" }] });
    expect(state.triggerMarketPoll).not.toHaveBeenCalled();
  });
});
