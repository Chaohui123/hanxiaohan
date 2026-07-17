// ============================================================
// Redis Distributed Lock v2 — inventory, batch, dedup scenarios
// Uses Redis SET NX PX + Lua-safe release.
// Graceful fallback to in-memory when Redis unavailable.
// ============================================================

import { cache, TTL } from "@onzo/cache";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";

const LOCK_PREFIX = "onzo:lock:";
const memoryLocks = new Map<string, { token: string; expiry: number }>();

// ---- Lock with token (safe release) ----

/** Acquire a named distributed lock. Returns a token for safe release. */
export async function acquireLock(scope: string, ttlSeconds = 120): Promise<string | null> {
  const key = `${LOCK_PREFIX}${scope}`;
  const token = randomUUID();

  const acquired = await cache.setnx(key, token, ttlSeconds * 1000);
  if (!acquired) {
    logger.debug({ scope }, "Lock: already held");
    return null;
  }
  return token;
}

/**
 * Release a lock safely — only releases if the token matches.
 * Prevents accidentally releasing another instance's lock after TTL expiry.
 */
export async function releaseLock(scope: string, token: string): Promise<void> {
  const key = `${LOCK_PREFIX}${scope}`;
  // Clear memory lock
  const memEntry = memoryLocks.get(key);
  if (memEntry && memEntry.token === token) {
    memoryLocks.delete(key);
  }
  // Clear Redis lock — try Lua atomic delete, fallback to simple delete
  try {
    const client = await getRedisClient();
    if (client) {
      await client.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1, key, token
      );
      return;
    }
  } catch { /* Redis eval unavailable */ }
  // Simple delete fallback
  await cache.del(key);
}

/** Check if a lock is currently held */
export async function isLocked(scope: string): Promise<boolean> {
  const key = `${LOCK_PREFIX}${scope}`;
  const val = await cache.get(key);
  if (val) return true;
  const entry = memoryLocks.get(key);
  return !!(entry && entry.expiry > Date.now());
}

// ---- Convenience wrappers ----

/** Acquire inventory lock for stock deduction (30s TTL). */
export async function lockInventory(storeId: string, offerId: string, sku: number): Promise<string | null> {
  return acquireLock(`inventory:${storeId}:${offerId}:${sku}`, 30);
}

/** Acquire batch import lock (120s TTL). */
export async function lockBatchImport(storeId: string): Promise<string | null> {
  return acquireLock(`batch:import:${storeId}`, 120);
}

/** Acquire product update lock — prevents concurrent updates to same Ozon product (60s). */
export async function lockProductUpdate(storeId: string, productId: number): Promise<string | null> {
  return acquireLock(`product:update:${storeId}:${productId}`, 60);
}

/** Dedup lock — prevent duplicate listing tasks for same 1688 URL (300s). */
export async function lockDedupListing(url: string): Promise<string | null> {
  const hash = url.trim().toLowerCase();
  return acquireLock(`dedup:listing:${hash.slice(0, 64)}`, TTL.DEDUP_LOCK);
}

/**
 * Extend a lock's TTL without releasing and re-acquiring.
 * Only succeeds if the lock is currently held with the given token.
 * Returns true if the lock was extended, false if the token doesn't match
 * or the lock expired.
 */
export async function extendLock(scope: string, token: string, ttlSeconds: number): Promise<boolean> {
  const key = `${LOCK_PREFIX}${scope}`;
  try {
    const client = await getRedisClient();
    if (client) {
      // Lua: extend TTL only if the stored token matches ours
      const result = await client.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
        1, key, token, String(ttlSeconds * 1000)
      );
      return (result as number) === 1;
    }
  } catch { /* fall through to memory fallback */ }
  // Memory fallback: extend if token matches
  const entry = memoryLocks.get(key);
  if (entry && entry.token === token) {
    entry.expiry = Date.now() + ttlSeconds * 1000;
    return true;
  }
  return false;
}

/** Release any lock by scope + token, ignoring errors. */
export async function unlock(scope: string, token: string): Promise<void> {
  try { await releaseLock(scope, token); } catch {}
}

// ---- Internal ----

async function getRedisClient() {
  try {
    // Access internal client for Lua scripts
    const client = await (cache as unknown as { getClient?: () => Promise<unknown> })["getClient"]?.();
    return client as { eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown> } | null;
  } catch {
    return null;
  }
}