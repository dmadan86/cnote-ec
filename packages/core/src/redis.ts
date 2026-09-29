import Redis from "ioredis";

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 3, lazyConnect: false });
if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

/** Cache-aside helper. */
export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await load();
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}

/** Fixed-window rate limit. Returns true if the call is allowed. */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSeconds);
  return n <= limit;
}
