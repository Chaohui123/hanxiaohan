// scheduler 首跑竞争回归（2026-09-06：60s tick 抢跑 stagger 导致启动期双跑）
// 注意：jobs 为模块级单例，本文件单用例内顺序验证（index 0/1 stagger 10s/20s）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerJob, startScheduler, stopScheduler, getJobsStatus } from "../src/services/scheduler.js";

describe("scheduler 首跑", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => { await stopScheduler(); vi.useRealTimers(); });

  it("启动期不双跑 + interval 正常重复", async () => {
    let runsA = 0, runsB = 0;
    registerJob("t-first-run", 24 * 3600_000, async () => { runsA++; });   // index 0 → stagger 10s
    registerJob("t-interval", 120_000, async () => { runsB++; });          // index 1 → stagger 20s
    await startScheduler(); // 无 REDIS_URL → standalone leader

    await vi.advanceTimersByTimeAsync(10_500);  // A 的 stagger 到点
    expect(runsA).toBe(1);
    expect(runsB).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);  // 20.5s：B 的 stagger 到点
    expect(runsB).toBe(1);

    await vi.advanceTimersByTimeAsync(50_000);  // 70.5s：第一次 60s tick——都跑过，不双跑
    expect(runsA).toBe(1);
    expect(runsB).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);  // 130.5s：B 距上次 110s < 120s，未到
    expect(runsB).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);  // 190.5s：B 到 interval 重跑；A（24h）不跑
    expect(runsB).toBeGreaterThanOrEqual(2);
    expect(runsA).toBe(1);
    expect(getJobsStatus()[0].lastRun).not.toBeNull();
  });
});
