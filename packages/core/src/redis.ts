import Redis from "ioredis";

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 3, lazyConnect: false });
if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

const blockingByBase = new WeakMap<Redis, Map<string, Redis>>();
const allBlocking = new Set<Redis>();

/**
 * A dedicated connection for blocking reads (XREADGROUP … BLOCK). Redis runs one command at a time per connection, so a
 * blocking read on the shared client queues everything else behind it: with one BLOCK 1000 per consumer group, an outbox
 * publish waited ~25s and timed out its Prisma transaction. One duplicate per (base client, key), created lazily.
 */
export function blockingConnection(base: Redis, key: string): Redis {
  let byKey = blockingByBase.get(base);
  if (!byKey) blockingByBase.set(base, (byKey = new Map()));
  let conn = byKey.get(key);
  if (!conn) {
    conn = base.duplicate();
    byKey.set(key, conn);
    allBlocking.add(conn);
  }
  return conn;
}

/** Close every dedicated blocking connection (shutdown, tests). */
export async function closeBlockingConnections(): Promise<void> {
  const conns = [...allBlocking];
  allBlocking.clear();
  await Promise.all(
    conns.map(async (c) => {
      try {
        await c.quit();
      } catch {
        c.disconnect();
      }
    }),
  );
}

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

// ---------------------------------------------------------------------------------------------
// Tagged read-through cache (performance layer). Additive: `cached` / `rateLimit` above are unchanged.
//
//  - Values are stored as a JSON envelope { v, f (fresh-until ms), w (written ms) } so a hot key can be
//    served stale-while-revalidate (`staleSeconds`) while ONE caller refreshes it.
//  - Each entry registers itself in a Redis set per tag (`ctag:<tag>`). `invalidateTags` deletes every
//    entry under a tag ("hard": the next reader reloads; use for moderation / unpublish so unapproved
//    content can never be served). `softInvalidateTags` only marks entries older than now as stale
//    ("soft": SWR keeps serving the old value while it refreshes; use for ranking-ish data).
//  - Stampede protection: in-process request coalescing + a short cross-instance lock (SET NX).
//  - A fill that overlaps an invalidation never writes (per-tag invalidation timestamps), so an invalidated
//    entry cannot be resurrected by a slow loader.
//  - Fail-open: any Redis error degrades to calling `load()` directly.
// Never put per-user data in these caches.
// ---------------------------------------------------------------------------------------------

/** Canonical cache tag names shared by every module, the cache worker and the web revalidate endpoint. */
export const cacheTags = {
  categories: "categories",
  category: (slug: string) => `category:${slug}`,
  listing: (id: string) => `listing:${id}`,
  sellerListings: (businessId: string) => `seller-listings:${businessId}`,
  seller: (businessId: string) => `seller:${businessId}`,
  sellers: "sellers",
  featured: "featured",
  search: "search",
  rating: (listingId: string) => `rating:${listingId}`,
  reviews: (listingId: string) => `reviews:${listingId}`,
  reviewsAll: "reviews:all",
  /** public answered product questions of one listing / all listings (erasure) */
  qa: (listingId: string) => `qa:${listingId}`,
  qaAll: "qa:all",
  plans: "plans",
  sitemap: "sitemap",
} as const;

interface Envelope<T> {
  v: T;
  f: number;
  w: number;
}
type Tags<T> = string[] | ((value: T) => string[]);

const MAX_TTL_S = 24 * 3600;
const TAG_SET_TTL_S = 2 * 24 * 3600;
const inflight = new Map<string, Promise<unknown>>();
const stats = new Map<string, { hit: number; miss: number; stale: number; error: number }>();

const bucketOf = (key: string) => key.split(":").slice(0, 2).join(":");

function count(key: string, kind: "hit" | "miss" | "stale" | "error") {
  const b = bucketOf(key);
  const s = stats.get(b) ?? { hit: 0, miss: 0, stale: 0, error: 0 };
  s[kind]++;
  stats.set(b, s);
  if (process.env.CACHE_LOG === "1") console.log(`[cache] ${kind} ${key}`);
}

/** Hit/miss/stale/error counters per key family since process start (for logs, /api/health, tests). */
export function getCacheStats(): Record<string, { hit: number; miss: number; stale: number; error: number; hitRatio: number }> {
  return Object.fromEntries(
    [...stats].map(([k, s]) => [k, { ...s, hitRatio: s.hit + s.stale + s.miss ? (s.hit + s.stale) / (s.hit + s.stale + s.miss) : 0 }]),
  );
}

/** True when any tag was hard-invalidated at or after `since` (ms). Used so a slow loader can't resurrect a purged entry. */
async function invalidatedSince(tags: string[], since: number): Promise<boolean> {
  if (!tags.length) return false;
  try {
    return (await redis.mget(...tags.map((t) => `ctagv:${t}`))).some((v) => v !== null && Number(v) >= since - 1);
  } catch {
    return false;
  }
}

async function store<T>(key: string, value: T, tagList: string[], ttl: number, stale: number): Promise<void> {
  const now = Date.now();
  const total = Math.min(MAX_TTL_S, ttl + stale);
  const env: Envelope<T> = { v: value, f: now + ttl * 1000, w: now };
  const pipe = redis.pipeline().set(key, JSON.stringify(env), "EX", total);
  for (const t of tagList) pipe.sadd(`ctag:${t}`, key).expire(`ctag:${t}`, TAG_SET_TTL_S);
  await pipe.exec();
}

async function isSoftStale(env: Envelope<unknown>, softStamps: (string | null)[]): Promise<boolean> {
  return softStamps.some((s) => s !== null && Number(s) > env.w);
}

/** Loads under a cross-instance lock so N instances don't all recompute the same cold key. */
async function fill<T>(key: string, tags: Tags<T>, ttl: number, stale: number, load: () => Promise<T>, staticTags: string[]): Promise<T> {
  const lockKey = `clock:${key}`;
  let locked = false;
  try {
    locked = (await redis.set(lockKey, "1", "EX", 15, "NX")) === "OK";
    if (!locked) {
      // Another instance is loading: poll briefly for its result before falling back to loading ourselves.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const raw = await redis.get(key);
        if (raw !== null) return (JSON.parse(raw) as Envelope<T>).v;
      }
    }
  } catch {
    /* fail open */
  }
  try {
    const startedAt = Date.now();
    const value = await load();
    try {
      const tagList = typeof tags === "function" ? tags(value) : tags;
      // A hard invalidation raced with this load: return the value but don't cache it.
      const all = [...new Set([...staticTags, ...tagList])];
      if (!(await invalidatedSince(all, startedAt))) {
        await store(key, value, tagList, ttl, stale);
        // check-then-store is not atomic: an invalidation landing between the check and the write has already listed the tag's
        // members and would miss this entry. invalidateTags stamps `ctagv` BEFORE listing, so re-checking after the write catches it.
        if (await invalidatedSince(all, startedAt)) await redis.del(key);
      }
    } catch {
      count(key, "error");
    }
    return value;
  } finally {
    if (locked) redis.del(lockKey).catch(() => undefined);
  }
}

function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Read-through cache with tags, SWR and stampede protection.
 * `ttlSeconds` is the fresh window; for a further `staleSeconds` the old value is served while one caller refreshes.
 * `tags` may be a function of the loaded value (e.g. one `listing:<id>` tag per search hit).
 */
export async function cachedTagged<T>(
  key: string,
  tags: Tags<T>,
  ttlSeconds: number,
  load: () => Promise<T>,
  opts: { staleSeconds?: number; softTags?: string[] } = {},
): Promise<T> {
  const stale = opts.staleSeconds ?? 0;
  const staticTags = Array.isArray(tags) ? tags : [];
  const softTags = opts.softTags ?? staticTags;
  let env: Envelope<T> | null = null;
  let soft: (string | null)[] = [];
  try {
    const pipe = redis.pipeline().get(key);
    if (softTags.length) pipe.mget(...softTags.map((t) => `ctags:${t}`));
    const res = await pipe.exec();
    const raw = res?.[0]?.[1] as string | null | undefined;
    if (raw) env = JSON.parse(raw) as Envelope<T>;
    if (softTags.length) soft = (res?.[1]?.[1] as (string | null)[] | undefined) ?? [];
  } catch {
    count(key, "error");
    return load(); // Redis down: serve straight from the source
  }
  if (env) {
    const fresh = env.f > Date.now() && !(await isSoftStale(env, soft));
    if (fresh) {
      count(key, "hit");
      return env.v;
    }
    count(key, "stale");
    void coalesce(`refresh:${key}`, () => fill(key, tags, ttlSeconds, stale, load, staticTags)).catch((err) =>
      console.error(`[cache] background refresh failed for ${key}:`, err instanceof Error ? err.message : err),
    );
    return env.v;
  }
  count(key, "miss");
  return coalesce(key, () => fill(key, tags, ttlSeconds, stale, load, staticTags));
}

/**
 * Batch variant for id -> value lookups (trust profiles, listings, rating summaries). One MGET for the
 * whole batch, one `load(missingIds)` for the misses, per-id keys `${prefix}:${id}`. Absent ids are not cached.
 */
export async function cachedManyTagged<T>(
  ids: string[],
  o: { prefix: string; tags: (id: string) => string[]; ttlSeconds: number; staleSeconds?: number; load: (missing: string[]) => Promise<Map<string, T>> },
): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, T>();
  if (!unique.length) return out;
  const stale = o.staleSeconds ?? 0;
  const keyOf = (id: string) => `${o.prefix}:${id}`;
  let missing = unique;
  const staleIds: string[] = [];
  try {
    const raws = await redis.mget(...unique.map(keyOf));
    missing = [];
    const now = Date.now();
    unique.forEach((id, i) => {
      const raw = raws[i];
      if (!raw) return void missing.push(id);
      const env = JSON.parse(raw) as Envelope<T>;
      out.set(id, env.v);
      if (env.f <= now) staleIds.push(id);
    });
  } catch {
    count(o.prefix, "error");
    return o.load(unique);
  }
  for (const id of unique) if (out.has(id)) count(keyOf(id), staleIds.includes(id) ? "stale" : "hit");
  const refresh = async (want: string[]) => {
    const tagList = [...new Set(want.flatMap((id) => o.tags(id)))];
    const startedAt = Date.now();
    const loaded = await o.load(want);
    try {
      if (!(await invalidatedSince(tagList, startedAt))) {
        const pipe = redis.pipeline();
        const now = Date.now();
        const total = Math.min(MAX_TTL_S, o.ttlSeconds + stale);
        for (const [id, v] of loaded) {
          pipe.set(keyOf(id), JSON.stringify({ v, f: now + o.ttlSeconds * 1000, w: now } satisfies Envelope<T>), "EX", total);
          for (const t of o.tags(id)) pipe.sadd(`ctag:${t}`, keyOf(id)).expire(`ctag:${t}`, TAG_SET_TTL_S);
        }
        await pipe.exec();
        // see fill(): close the check-then-store race with a concurrent hard invalidation
        if (await invalidatedSince(tagList, startedAt)) await redis.del(...[...loaded.keys()].map(keyOf));
      }
    } catch {
      count(o.prefix, "error");
    }
    return loaded;
  };
  if (staleIds.length) void coalesce(`refresh:${o.prefix}:${staleIds.sort().join(",")}`, () => refresh(staleIds)).catch(() => undefined);
  if (missing.length) {
    for (const id of missing) count(keyOf(id), "miss");
    const loaded = await coalesce(`many:${o.prefix}:${[...missing].sort().join(",")}`, () => refresh(missing));
    for (const [id, v] of loaded) out.set(id, v);
  }
  return out;
}

/** Hard invalidation: every entry registered under any of `tags` is deleted. Safe to call from write paths (never throws). */
export async function invalidateTags(tags: string[]): Promise<void> {
  const list = [...new Set(tags)].filter(Boolean);
  if (!list.length) return;
  try {
    for (const t of list) {
      // Stamp first, then list members: a fill that stores after we list sees the stamp when it re-checks (see fill()).
      await redis.set(`ctagv:${t}`, String(Date.now()), "EX", 3600);
      const keys = await redis.smembers(`ctag:${t}`);
      const pipe = redis.pipeline();
      if (keys.length) pipe.del(...keys);
      pipe.del(`ctag:${t}`);
      await pipe.exec();
    }
  } catch (err) {
    console.error("[cache] invalidateTags failed:", err instanceof Error ? err.message : err);
  }
}

/** Soft invalidation: entries written before now become stale (served once more while SWR refreshes). Static-tag entries only. */
export async function softInvalidateTags(tags: string[]): Promise<void> {
  const list = [...new Set(tags)].filter(Boolean);
  if (!list.length) return;
  try {
    const pipe = redis.pipeline();
    const now = String(Date.now());
    for (const t of list) pipe.set(`ctags:${t}`, now, "EX", MAX_TTL_S);
    await pipe.exec();
  } catch (err) {
    console.error("[cache] softInvalidateTags failed:", err instanceof Error ? err.message : err);
  }
}
