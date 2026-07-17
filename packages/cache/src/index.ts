// ============================================================
// Redis Cache Layer v2 — typed caches, TTL tiers, REDIS_SWITCH
// Graceful degradation: Redis → in-memory Map when disabled/unavailable
// ============================================================

import { logger } from "@onzo/logger";

let redisClient: Awaited<ReturnType<typeof createClient>> = null;
let connectionAttempted = false;

const REDIS_ENABLED = process.env.REDIS_ENABLED !== "false";
const REDIS_SWITCH = process.env.REDIS_SWITCH;
const redisOn = REDIS_SWITCH ? REDIS_SWITCH !== "false" && REDIS_SWITCH !== "0" : REDIS_ENABLED;

async function createClient() {
  const url = process.env.REDIS_URL;
  if (!url || !redisOn) return null;

  try {
    const RedisMod = await import("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Redis = (RedisMod as any).default || RedisMod;
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      retryStrategy(times: number) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    client.on("error", (err: Error) => {
      logger.warn({ err: err.message }, "Redis connection error");
    });

    client.on("connect", () => {
      logger.info("Redis connected");
    });

    await client.connect();
    logger.info("Redis cache layer active");
    return client;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Redis unavailable — using memory fallback");
    return null;
  }
}

async function getClient() {
  if (!connectionAttempted) {
    connectionAttempted = true;
    redisClient = await createClient();
  }
  return redisClient;
}

// ---- TTL Tiers (seconds) ----

export const TTL = {
  STORE_CONFIG: 3600,       // 1 hour
  CATEGORY_MATCH: 1800,     // 30 min
  LLM_TRANSLATION: 900,     // 15 min
  DASHBOARD_STATS: 60,      // 1 min
  EXCHANGE_RATE: 3600,      // 1 hour
  RATE_LIMIT: 60,           // 1 min
  DEDUP_LOCK: 300,          // 5 min
  DIST_LOCK: 120,           // 2 min
  SESSION: 86400,           // 24 hours
} as const;

// ---- In-memory fallback ----

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

// ---- Typed Cache Helpers ----

function cacheKey(namespace: string, key: string): string {
  return `onzo:${namespace}:${key}`;
}

// ---- RedisCache Class ----

export class RedisCache {
  // ---- Basic ops ----

  async get(key: string): Promise<string | null> {
    const client = await getClient();
    if (client) {
      try { return await client.get(key); } catch { /* fall through */ }
    }
    const entry = memoryStore.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    memoryStore.delete(key);
    return null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const client = await getClient();
    if (client) {
      try {
        if (ttlSeconds) await client.setex(key, ttlSeconds, value);
        else await client.set(key, value);
        return;
      } catch { /* fall through */ }
    }
    memoryStore.set(key, { value, expiresAt: Date.now() + (ttlSeconds || 300) * 1000 });
  }

  async del(key: string): Promise<void> {
    const client = await getClient();
    if (client) { try { await client.del(key); return; } catch {} }
    memoryStore.delete(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    const client = await getClient();
    if (client) {
      try { return await client.mget(keys); } catch {}
    }
    return keys.map((k) => {
      const e = memoryStore.get(k);
      return e && e.expiresAt > Date.now() ? e.value : null;
    });
  }

  async mset(entries: Array<{ key: string; value: string; ttl?: number }>): Promise<void> {
    const client = await getClient();
    if (client) {
      try {
        const multi = client.multi();
        for (const e of entries) {
          if (e.ttl) multi.setex(e.key, e.ttl, e.value);
          else multi.set(e.key, e.value);
        }
        await multi.exec();
        return;
      } catch {}
    }
    for (const e of entries) {
      memoryStore.set(e.key, { value: e.value, expiresAt: Date.now() + (e.ttl || 300) * 1000 });
    }
  }

  async incr(key: string): Promise<number> {
    const client = await getClient();
    if (client) {
      try { return await client.incr(key); } catch {}
    }
    const entry = memoryStore.get(key);
    const val = entry ? parseInt(entry.value) + 1 : 1;
    memoryStore.set(key, { value: String(val), expiresAt: Date.now() + 3600_000 });
    return val;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const client = await getClient();
    if (client) { try { await client.expire(key, ttlSeconds); return; } catch {} }
    const entry = memoryStore.get(key);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  async setnx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const client = await getClient();
    if (client) {
      try {
        const result = await client.set(key, value, "PX", ttlMs, "NX");
        return result === "OK";
      } catch { /* fall through */ }
    }
    const existing = memoryStore.get(key);
    if (existing && existing.expiresAt > Date.now()) return false;
    memoryStore.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async ping(): Promise<boolean> {
    const client = await getClient();
    if (!client) return false;
    try { return (await client.ping()) === "PONG"; } catch { return false; }
  }

  async healthCheck(): Promise<{ available: boolean; latencyMs: number }> {
    const client = await getClient();
    if (!client) return { available: false, latencyMs: 0 };
    try {
      const t0 = Date.now();
      await client.ping();
      return { available: true, latencyMs: Date.now() - t0 };
    } catch {
      return { available: false, latencyMs: 0 };
    }
  }

  // ---- Typed cache API (namespace + key + JSON serde) ----

  async cachedGet<T>(namespace: string, key: string): Promise<T | null> {
    const raw = await this.get(cacheKey(namespace, key));
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  async cachedSet<T>(namespace: string, key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.set(cacheKey(namespace, key), JSON.stringify(value), ttlSeconds);
  }

  async cachedDel(namespace: string, key: string): Promise<void> {
    await this.del(cacheKey(namespace, key));
  }

  // In-flight dedup: prevent thundering herd when TTL expires under concurrent load.
  // Multiple concurrent callers for the same key share one factory invocation.
  private _inflight = new Map<string, Promise<unknown>>();

  async cachedGetOrSet<T>(namespace: string, key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.cachedGet<T>(namespace, key);
    if (cached !== null) return cached;

    const ck = cacheKey(namespace, key);
    const inflight = this._inflight.get(ck) as Promise<T> | undefined;
    if (inflight) return inflight;

    const promise = factory().then(
      async (value) => {
        this._inflight.delete(ck);
        await this.cachedSet(namespace, key, value, ttlSeconds).catch(() => {});
        return value;
      },
      (err) => {
        this._inflight.delete(ck);
        throw err;
      }
    );
    this._inflight.set(ck, promise);
    return promise;
  }

  // ---- Counter API (namespaced) ----

  async counterIncr(namespace: string, key: string, ttlSeconds?: number): Promise<number> {
    const ck = cacheKey(namespace, key);
    const val = await this.incr(ck);
    if (ttlSeconds) await this.expire(ck, ttlSeconds).catch(() => {});
    return val;
  }

  async counterGet(namespace: string, key: string): Promise<number> {
    const raw = await this.get(cacheKey(namespace, key));
    return raw ? parseInt(raw, 10) : 0;
  }

  // ---- List/Queue API ----

  async listPush(key: string, value: string): Promise<void> {
    const client = await getClient();
    if (client) {
      try { await client.rpush(key, value); return; } catch {}
    }
    // Memory fallback: simple array
    const arr = JSON.parse(memoryStore.get(key)?.value || "[]") as string[];
    arr.push(value);
    memoryStore.set(key, { value: JSON.stringify(arr), expiresAt: Date.now() + 86400_000 });
  }

  async listPop(key: string): Promise<string | null> {
    const client = await getClient();
    if (client) {
      try { return await client.lpop(key); } catch {}
    }
    const entry = memoryStore.get(key);
    if (!entry) return null;
    const arr = JSON.parse(entry.value) as string[];
    const val = arr.shift() || null;
    memoryStore.set(key, { value: JSON.stringify(arr), expiresAt: entry.expiresAt });
    return val;
  }

  async listLength(key: string): Promise<number> {
    const client = await getClient();
    if (client) {
      try { return await client.llen(key); } catch {}
    }
    const entry = memoryStore.get(key);
    return entry ? JSON.parse(entry.value).length : 0;
  }

  // ---- Sorted Set API (for delay queue) ----

  async zadd(key: string, score: number, member: string): Promise<void> {
    const client = await getClient();
    if (client) {
      try { await client.zadd(key, score, member); return; } catch {}
    }
    // Memory fallback: store as sorted array
    const entry = memoryStore.get(key);
    const arr: Array<{ score: number; member: string }> = entry ? JSON.parse(entry.value) : [];
    arr.push({ score, member });
    arr.sort((a, b) => a.score - b.score);
    memoryStore.set(key, { value: JSON.stringify(arr), expiresAt: Date.now() + 86400_000 });
  }

  async zpopmin(key: string, count: number): Promise<Array<{ score: number; member: string }>> {
    const client = await getClient();
    if (client) {
      try {
        const results = await client.zpopmin(key, count);
        // ZPOPMIN returns [member1, score1, member2, score2, ...]
        const pairs: Array<{ score: number; member: string }> = [];
        for (let i = 0; i < results.length; i += 2) {
          pairs.push({ member: results[i]!, score: parseFloat(results[i + 1]!) || 0 });
        }
        return pairs;
      } catch {}
    }
    const entry = memoryStore.get(key);
    if (!entry) return [];
    const arr: Array<{ score: number; member: string }> = JSON.parse(entry.value);
    const popped = arr.splice(0, count);
    memoryStore.set(key, { value: JSON.stringify(arr), expiresAt: entry.expiresAt });
    return popped;
  }

  async zcard(key: string): Promise<number> {
    const client = await getClient();
    if (client) {
      try { return await client.zcard(key); } catch {}
    }
    const entry = memoryStore.get(key);
    return entry ? JSON.parse(entry.value).length : 0;
  }

  // ---- Status ----

  get enabled(): boolean {
    return redisOn;
  }
}

// Singleton
export const cache = new RedisCache();