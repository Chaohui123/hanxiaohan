// ============================================================
// Redis Integration Tests — cache, queue, lock, rate limiter
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ioredis
vi.mock("ioredis", () => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const sortedSets = new Map<string, Array<{ score: number; member: string }>>();
  return {
    default: vi.fn().mockImplementation(() => ({
      get: async (k: string) => store.get(k) || null,
      setex: async (k: string, _t: number, v: string) => { store.set(k, v); return "OK"; },
      set: vi.fn(async (k: string, v: string, ...args: string[]) => {
        // Handle SET key value PX ttl NX (distributed lock pattern)
        const argsStr = args.join(" ");
        if (argsStr.includes("NX") && argsStr.includes("PX")) {
          if (store.has(k)) return null;
          store.set(k, v);
          return "OK";
        }
        if (argsStr.includes("EX")) {
          store.set(k, v);
          return "OK";
        }
        store.set(k, v);
        return "OK";
      }),
      del: async (k: string) => { store.delete(k); return 1; },
      incr: async (k: string) => { const v = (parseInt(store.get(k) || "0") + 1); store.set(k, String(v)); return v; },
      expire: async () => "OK",
      ping: async () => "PONG",
      connect: async () => {},
      rpush: async (k: string, v: string) => {
        if (!lists.has(k)) lists.set(k, []);
        lists.get(k)!.push(v);
        return 1;
      },
      lpop: async (k: string) => {
        const arr = lists.get(k);
        return arr?.shift() || null;
      },
      llen: async (k: string) => lists.get(k)?.length || 0,
      zadd: async (k: string, score: number, member: string) => {
        if (!sortedSets.has(k)) sortedSets.set(k, []);
        sortedSets.get(k)!.push({ score, member });
        sortedSets.get(k)!.sort((a, b) => a.score - b.score);
        return 1;
      },
      zpopmin: async (k: string, count: number) => {
        const arr = sortedSets.get(k) || [];
        return arr.splice(0, count).map(e => [e.member, e.score]);
      },
      zcard: async (k: string) => sortedSets.get(k)?.length || 0,
      multi: () => ({ setex: () => {}, set: () => {}, exec: async () => [] }),
      eval: async (_script: string, _numKeys: number, _key: string, token: string) => {
        // Simple mock: delete if token matches "mock-token" or any token
        // In real Redis, this would only delete if the stored value matches
        store.delete(_key);
        return 1;
      },
      on: () => {},
    })),
  };
});

// Must import after mock
const { cache, TTL } = await import("@onzo/cache");

describe("Redis Cache v2", () => {
  it("caches and retrieves typed data", async () => {
    await cache.cachedSet("test", "key1", { name: "test", value: 42 }, 60);
    const result = await cache.cachedGet<{ name: string; value: number }>("test", "key1");
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("returns null for cache miss", async () => {
    const result = await cache.cachedGet("test", "nonexistent");
    expect(result).toBeNull();
  });

  it("cachedGetOrSet calls factory on miss, caches on hit", async () => {
    const factory = vi.fn().mockResolvedValue({ computed: true });
    const r1 = await cache.cachedGetOrSet("test", "factory", 60, factory);
    expect(r1).toEqual({ computed: true });
    expect(factory).toHaveBeenCalledTimes(1);

    // Second call should hit cache
    const r2 = await cache.cachedGetOrSet("test", "factory", 60, factory);
    expect(r2).toEqual({ computed: true });
    expect(factory).toHaveBeenCalledTimes(1); // still 1 — cache hit
  });
});

describe("Redis Lock", () => {
  beforeEach(async () => {
    await cache.del("onzo:lock:test:lock1");
  });

  it("acquires and releases lock with token", async () => {
    const { acquireLock, releaseLock } = await import("../src/services/redis-lock.js");
    const token = await acquireLock("test:lock1", 10);
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");

    // Second acquire should fail while lock is held
    const token2 = await acquireLock("test:lock1", 10);
    expect(token2).toBeNull();

    // Release the lock
    await releaseLock("test:lock1", token!);
    // Now should be acquirable again
    const token3 = await acquireLock("test:lock1", 10);
    expect(token3).toBeTruthy();
  });

  it("dedup lock works for listing URLs", async () => {
    const { lockDedupListing } = await import("../src/services/redis-lock.js");
    const t1 = await lockDedupListing("https://detail.1688.com/offer/123.html");
    expect(t1).toBeTruthy();
    const t2 = await lockDedupListing("https://detail.1688.com/offer/123.html");
    expect(t2).toBeNull();
  });
});

describe("Redis Delay Queue", () => {
  it("enqueues and dequeues tasks", async () => {
    const { enqueueDelayTask, queueDepth } = await import("../src/services/redis-delay-queue.js");

    await enqueueDelayTask({ id: "t1", type: "ozon_import_check", payload: {}, executeAt: Date.now() - 1000 });
    await enqueueDelayTask({ id: "t2", type: "draft_status", payload: {}, executeAt: Date.now() + 9999999 });

    const depth = await queueDepth();
    expect(depth).toBe(2);
  });
});

describe("Redis Rate Limiter", () => {
  it("counts requests per window", async () => {
    const key = "onzo:ratelimit:ozon:test-store";
    await cache.del(key);
    const c1 = await cache.counterIncr("ratelimit:ozon", "test-store", 60);
    expect(c1).toBe(1);
    const c2 = await cache.counterIncr("ratelimit:ozon", "test-store", 60);
    expect(c2).toBe(2);
  });
});