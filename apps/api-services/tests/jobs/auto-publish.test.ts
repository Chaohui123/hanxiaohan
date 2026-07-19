// ============================================================
// Auto-Publish Queue Consumer Tests — jobs/auto-publish.ts
// taskQueue / listing-runner / dead-letter / notifications all mocked
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskQueue, QueuedTask } from "../../src/db/task-queue.js";
import type { ListingInfra } from "../../src/services/listing-runner.js";

const mocks = vi.hoisted(() => ({
  runListingPipeline: vi.fn(),
  writeToDeadLetter: vi.fn().mockResolvedValue("dl-id"),
  categorizeError: vi.fn().mockReturnValue("unknown"),
  emitEvent: vi.fn().mockResolvedValue(undefined),
  recordPipelineFailure: vi.fn().mockResolvedValue(undefined),
  recordPipelineSuccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/listing-runner.js", () => ({
  runListingPipeline: mocks.runListingPipeline,
}));
vi.mock("../../src/services/dead-letter.js", () => ({
  writeToDeadLetter: mocks.writeToDeadLetter,
  categorizeError: mocks.categorizeError,
}));
vi.mock("../../src/services/notification-events.js", () => ({
  emitEvent: mocks.emitEvent,
  EVENT_KEYS: { LISTING_FAILED: "LISTING_FAILED", DEAD_LETTER_RETRY: "DEAD_LETTER_RETRY" },
}));
vi.mock("../../src/pipelines/listing-pipeline.js", () => ({
  recordPipelineFailure: mocks.recordPipelineFailure,
  recordPipelineSuccess: mocks.recordPipelineSuccess,
}));

import { processListingBatch } from "../../src/jobs/auto-publish.js";

// ---- Fixtures ----

function makeTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: "task-1",
    type: "listing",
    status: "processing",
    payload: { url: "https://detail.1688.com/offer/1.html" },
    correlationId: "corr-1",
    storeId: "store_1",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    retryCount: 0,
    maxRetries: 3,
    priority: 0,
    ...overrides,
  };
}

function makeQueue(tasks: QueuedTask[]) {
  return {
    dequeueBatch: vi.fn().mockResolvedValue(tasks),
    markDone: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(null),
  } as unknown as TaskQueue & {
    dequeueBatch: ReturnType<typeof vi.fn>;
    markDone: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}

const fakeInfra = {} as ListingInfra;
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noDelay = () => Promise.resolve();

function successResult() {
  return {
    ctx: { taskId: "ctx-1", correlationId: "corr-1", storeId: "store_1", sourceUrl: "https://detail.1688.com/offer/1.html", errors: [] },
    outcome: { kind: "success" as const, productId: 123, offerId: "OFFER-1", titleRu: "Тест" },
  };
}

function blockedResult(blockKind: string, reason = "blocked reason") {
  return {
    ctx: { taskId: "ctx-1", correlationId: "corr-1", storeId: "store_1", sourceUrl: "https://detail.1688.com/offer/1.html", errors: [] },
    outcome: { kind: "blocked" as const, blockKind, reason },
  };
}

function errorResult(message: string) {
  return {
    ctx: { taskId: "ctx-1", correlationId: "corr-1", storeId: "store_1", sourceUrl: "https://detail.1688.com/offer/1.html", errors: [] },
    outcome: { kind: "error" as const, error: new Error(message) },
  };
}

describe("processListingBatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns zero summary when no queued tasks", async () => {
    const taskQueue = makeQueue([]);
    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.dequeueBatch).toHaveBeenCalledWith(5, "listing");
    expect(summary).toEqual({ dequeued: 0, succeeded: 0, retried: 0, failed: 0, rejected: 0 });
    expect(mocks.runListingPipeline).not.toHaveBeenCalled();
  });

  it("marks done and records success on successful listing", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    mocks.runListingPipeline.mockResolvedValue(successResult());

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(mocks.runListingPipeline).toHaveBeenCalledWith(fakeInfra, {
      url: "https://detail.1688.com/offer/1.html", storeId: "store_1", correlationId: "corr-1",
    });
    expect(taskQueue.markDone).toHaveBeenCalledWith("task-1");
    expect(mocks.recordPipelineSuccess).toHaveBeenCalled();
    expect(summary.succeeded).toBe(1);
  });

  it("fails invalid payload (missing url) straight to dead letter without running pipeline", async () => {
    const task = makeTask({ payload: {} });
    const taskQueue = makeQueue([task]);

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(mocks.runListingPipeline).not.toHaveBeenCalled();
    expect(taskQueue.markFailed).toHaveBeenCalledWith("task-1", expect.stringContaining("missing 'url'"));
    expect(mocks.writeToDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ taskType: "listing" }));
    expect(mocks.emitEvent).toHaveBeenCalledWith("LISTING_FAILED", expect.any(Object), "corr-1");
    expect(summary.failed).toBe(1);
  });

  it("sends validation blocks to dead letter (not retried)", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    mocks.runListingPipeline.mockResolvedValue(blockedResult("validation", "Validation: title too short"));

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.retry).not.toHaveBeenCalled();
    expect(taskQueue.markFailed).toHaveBeenCalledWith("task-1", "Validation: title too short");
    expect(mocks.writeToDeadLetter).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: "Validation: title too short",
      payload: { url: "https://detail.1688.com/offer/1.html" },
    }));
    expect(mocks.recordPipelineFailure).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it("records pipeline failure for CN compliance blocks", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    mocks.runListingPipeline.mockResolvedValue(blockedResult("cn_compliance", "Requires certification"));

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.markFailed).toHaveBeenCalledWith("task-1", "Requires certification");
    expect(mocks.writeToDeadLetter).toHaveBeenCalled();
    expect(mocks.recordPipelineFailure).toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it("treats ops-review rejection as rejected (no dead letter)", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    mocks.runListingPipeline.mockResolvedValue(blockedResult("ops_review", "Price too low"));

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.markFailed).toHaveBeenCalledWith("task-1", expect.stringContaining("Ops review rejected"));
    expect(mocks.writeToDeadLetter).not.toHaveBeenCalled();
    expect(summary.rejected).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("re-queues transient errors via taskQueue.retry", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    taskQueue.retry.mockResolvedValue({ ...task, status: "queued", retryCount: 1 });
    mocks.runListingPipeline.mockResolvedValue(errorResult("429 too many requests"));
    mocks.categorizeError.mockReturnValue("rate_limit");

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.retry).toHaveBeenCalledWith("task-1");
    expect(taskQueue.markFailed).not.toHaveBeenCalled();
    expect(mocks.writeToDeadLetter).not.toHaveBeenCalled();
    expect(summary.retried).toBe(1);
  });

  it("sends to dead letter when retries are exhausted", async () => {
    const task = makeTask({ retryCount: 3 });
    const taskQueue = makeQueue([task]);
    taskQueue.retry.mockResolvedValue(null); // maxRetries reached
    mocks.runListingPipeline.mockResolvedValue(errorResult("fetch failed"));
    mocks.categorizeError.mockReturnValue("network");

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.retry).toHaveBeenCalledWith("task-1");
    expect(taskQueue.markFailed).toHaveBeenCalledWith("task-1", "fetch failed");
    expect(mocks.writeToDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: "fetch failed" }));
    expect(mocks.recordPipelineFailure).toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it("sends non-retryable errors straight to dead letter", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    mocks.runListingPipeline.mockResolvedValue(errorResult("Category matching returned invalid ID"));
    mocks.categorizeError.mockReturnValue("validation");

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.retry).not.toHaveBeenCalled();
    expect(taskQueue.markFailed).toHaveBeenCalled();
    expect(mocks.writeToDeadLetter).toHaveBeenCalled();
    expect(mocks.emitEvent).toHaveBeenCalledWith("LISTING_FAILED", expect.any(Object), "corr-1");
    expect(summary.failed).toBe(1);
  });

  it("handles unexpected runner throws via the error grading path", async () => {
    const task = makeTask();
    const taskQueue = makeQueue([task]);
    mocks.runListingPipeline.mockRejectedValue(new Error("unexpected boom"));
    mocks.categorizeError.mockReturnValue("unknown");

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: noDelay,
    });

    expect(taskQueue.markFailed).toHaveBeenCalledWith("task-1", "unexpected boom");
    expect(mocks.writeToDeadLetter).toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it("applies anti-bot jitter between tasks (not after the last one)", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" }), makeTask({ id: "t3" })];
    const taskQueue = makeQueue(tasks);
    mocks.runListingPipeline.mockResolvedValue(successResult());
    const delay = vi.fn().mockResolvedValue(undefined);

    const summary = await processListingBatch({
      taskQueue, listingInfra: fakeInfra, batchSize: 5, logger: fakeLogger, delayBetweenTasks: delay,
    });

    expect(delay).toHaveBeenCalledTimes(2);
    expect(summary.succeeded).toBe(3);
  });
});
