// Redis rate-limit persistence — optional, only loaded when REDIS_URL is set
// Phase 1 default: in-memory bucket (no Redis required)
// Phase 2+: set REDIS_URL=redis://... for multi-process rate limiting
// Note: ioredis is NOT installed by default — install it only when enabling Redis

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;

async function loadRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  try {
    const RedisMod = await import("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Redis = (RedisMod as any).default || RedisMod;
    const client = new Redis(redisUrl);
    client.on("error", (err: Error) => {
      console.error("Redis error:", err);
    });
    return client;
  } catch {
    return null;
  }
}

async function getClient() {
  if (!redisClient) {
    redisClient = await loadRedis();
  }
  return redisClient;
}

export async function getRateLimitBucket(ip: string): Promise<{ tokens: number; lastRefill: number } | null> {
  const client = await getClient();
  if (!client) return null;

  const key = `ratelimit:${ip}`;
  try {
    const results: Array<[Error | null, string | null]> = await client.multi()
      .hget(key, "tokens")
      .hget(key, "lastRefill")
      .exec();

    const tokens = results?.[0]?.[1];
    const lastRefill = results?.[1]?.[1];
    return {
      tokens: tokens ? parseFloat(tokens) : 60,
      lastRefill: lastRefill ? parseInt(lastRefill, 10) : Date.now(),
    };
  } catch {
    return null;
  }
}

export async function setRateLimitBucket(ip: string, tokens: number, lastRefill: number): Promise<void> {
  const client = await getClient();
  if (!client) return;

  const key = `ratelimit:${ip}`;
  try {
    await client.hmset(key, {
      tokens: tokens.toString(),
      lastRefill: lastRefill.toString(),
    });
    await client.expire(key, 5 * 60);
  } catch {
    // Redis unavailable, ignore
  }
}
