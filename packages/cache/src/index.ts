// ============================================================
// Redis Cache Layer — optional, falls back to in-memory/SQLite
// Set REDIS_URL=redis://... to enable Redis
// All methods gracefully degrade when Redis is unavailable.
// ============================================================

import { logger } from "@onzo/logger";

let redisClient: Awaited<ReturnType<typeof createClient>> = null;
let connectionAttempted = false;

async function createClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
        // @ts-expect-error ioredis default export construct signature varies between v4/v5
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      retryStrategy(times: number) {
        if (times > 3) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    client.on("error", (err: Error) => {
      logger.warn({ err: err.message }, "Redis connection error");
    });

    client.on("connect", () => {
      logger.info("Redis connected");
    });

    await client.connect();
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

// In-memory fallback
const memoryStore = new Map<string, { value: string; expiresAt: number }>();

export class RedisCache {
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
}

// Singleton instance
export const cache = new RedisCache();
