import { createHash, randomBytes } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { classifyBot, classifyDevice, classifySource, type TrafficParams } from "./classify";

// Privacy: raw IP / user agent are hashed with a daily-rotating salt into a HyperLogLog and never stored.
// All hot-path work is ONE Redis EVAL (counters + HLL + dirty marker). A 5-minute job copies absolute
// totals to Postgres (upsert-by-set, so re-running or replaying a flush is idempotent).

export type HostKind = "custom" | "subdomain" | "path";

export interface HitInput {
  host: string;
  path: string;
  referrer?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  utm?: TrafficParams;
  /** set by callers that already resolved the host (the web proxy) to skip a second lookup */
  storefrontSlug: string;
  hostKind: HostKind;
  /** hosts considered "ourselves" for internal-referrer detection (the request host, the platform host) */
  ownHosts?: string[];
}

const COUNTER_TTL_S = 3 * 24 * 3600;
const FIELD_CAP = 3000; // distinct pages+referrers+bots per storefront per day; the rest fold into "(other)"
const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|zip|xml|txt|json|webmanifest)$/i;
const IST_OFFSET_MS = 5.5 * 3600_000;

/** Traffic day in IST (YYYY-MM-DD): the seller-facing "today". */
export function dayKey(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export const keys = {
  hash: (day: string, slug: string) => `sfm:h:${day}:${slug}`,
  hll: (day: string, slug: string) => `sfm:u:${day}:${slug}`,
  dirty: (day: string) => `sfm:dirty:${day}`,
  flushing: (day: string) => `sfm:flushing:${day}`,
  salt: (day: string) => `sfm:salt:${day}`,
};

const saltCache = new Map<string, string>();
/** Daily salt, created on first use and kept 48h so a late request at midnight still hashes consistently. */
export async function dailySalt(day: string = dayKey()): Promise<string> {
  const hit = saltCache.get(day);
  if (hit) return hit;
  const k = keys.salt(day);
  await redis.set(k, randomBytes(32).toString("hex"), "EX", 48 * 3600, "NX");
  const salt = (await redis.get(k)) ?? randomBytes(32).toString("hex");
  saltCache.clear();
  saltCache.set(day, salt);
  return salt;
}

export function visitorHash(salt: string, ip: string | null | undefined, ua: string | null | undefined): string {
  return createHash("sha256").update(`${salt}|${ip ?? ""}|${ua ?? ""}`).digest("hex").slice(0, 32);
}

/** Normalise to a path only (no query/hash), collapse trailing slash, clip. */
export function normalizePath(p: string): string {
  let path = p.split(/[?#]/)[0] || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  return path.slice(0, 120);
}

/** Should this request count as a page view? (documents only; assets and well-known probes do not.) */
export function isPageView(path: string): boolean {
  return !path.startsWith("/_next/") && !path.startsWith("/.well-known/") && !path.startsWith("/api/") && !STATIC_EXT.test(path);
}

const RECORD_LUA = `
local cap = tonumber(ARGV[1]); local ttl = tonumber(ARGV[2]); local n = tonumber(ARGV[3])
for i = 0, n - 1 do
  local f = ARGV[4 + i * 2]; local inc = ARGV[5 + i * 2]
  local p4 = string.sub(f, 1, 4); local p5 = string.sub(f, 1, 5)
  local capped = (p5 == 'page:' or p4 == 'ref:' or p4 == 'bot:')
  if capped and redis.call('HEXISTS', KEYS[1], f) == 0 and redis.call('HLEN', KEYS[1]) >= cap then
    if p5 == 'page:' then f = 'page:(other)' elseif p4 == 'bot:' then f = 'bot:(other)' else f = 'ref:(other)' end
  end
  redis.call('HINCRBY', KEYS[1], f, inc)
end
redis.call('EXPIRE', KEYS[1], ttl)
local h = ARGV[4 + n * 2]
if h ~= '' then redis.call('PFADD', KEYS[2], h); redis.call('EXPIRE', KEYS[2], ttl) end
redis.call('SADD', KEYS[3], ARGV[5 + n * 2]); redis.call('EXPIRE', KEYS[3], ttl)
return 1
`;

export interface HitClassification {
  fields: [string, number][];
  countsVisitor: boolean;
}

/** Pure: which counters one request bumps. Exposed for tests. */
export function classifyHit(h: Omit<HitInput, "storefrontSlug"> & { storefrontSlug?: string }): HitClassification {
  const path = normalizePath(h.path);
  const fields: [string, number][] = [["req", 1], [`hk:${h.hostKind}`, 1]];
  const bot = classifyBot(h.userAgent);
  if (bot) {
    fields.push([`bot:${bot.name}`, 1]);
    return { fields, countsVisitor: false };
  }
  if (!isPageView(path)) return { fields, countsVisitor: false };
  fields.push(["pv", 1], [`page:${path}`, 1], [`dev:${classifyDevice(h.userAgent)}`, 1]);
  const src = classifySource({ referrer: h.referrer, params: h.utm, ownHosts: [h.host, ...(h.ownHosts ?? [])] });
  if (!src.internal) fields.push([`src:${src.source}`, 1], [`ref:${src.label}`, 1]);
  return { fields, countsVisitor: true };
}

/** Hot path. Cheap: one hash + one EVAL. Never throws (metering must not break page serving). */
export async function recordHit(h: HitInput, day: string = dayKey()): Promise<void> {
  try {
    const c = classifyHit(h);
    const hash = c.countsVisitor ? visitorHash(await dailySalt(day), h.ip, h.userAgent) : "";
    const args: (string | number)[] = [FIELD_CAP, COUNTER_TTL_S, c.fields.length];
    for (const [f, n] of c.fields) args.push(f, n);
    args.push(hash, h.storefrontSlug);
    await redis.eval(RECORD_LUA, 3, keys.hash(day, h.storefrontSlug), keys.hll(day, h.storefrontSlug), keys.dirty(day), ...args.map(String));
  } catch (err) {
    console.error("[domains] recordHit failed:", err instanceof Error ? err.message : err);
  }
}

/** Count an enquiry started from a storefront (conversion). */
export async function recordStorefrontEnquiry(storefrontSlug: string, day: string = dayKey()): Promise<void> {
  try {
    await redis
      .pipeline()
      .hincrby(keys.hash(day, storefrontSlug), "enq", 1)
      .expire(keys.hash(day, storefrontSlug), COUNTER_TTL_S)
      .sadd(keys.dirty(day), storefrontSlug)
      .expire(keys.dirty(day), COUNTER_TTL_S)
      .exec();
  } catch (err) {
    console.error("[domains] recordStorefrontEnquiry failed:", err instanceof Error ? err.message : err);
  }
}

// ---- flush -------------------------------------------------------------------------------------

export interface DailyTotals {
  requests: number;
  pageviews: number;
  enquiries: number;
  uniqueVisitors: number;
  bySource: Record<string, number>;
  byReferrer: Record<string, number>;
  byPage: Record<string, number>;
  byDevice: Record<string, number>;
  botHits: Record<string, number>;
  byHostKind: Record<string, number>;
}

/** Fold a Redis hash (field -> count) into the DailyTotals shape. Pure. */
export function totalsFromHash(hash: Record<string, string>, uniques: number): DailyTotals {
  const t: DailyTotals = { requests: 0, pageviews: 0, enquiries: 0, uniqueVisitors: uniques, bySource: {}, byReferrer: {}, byPage: {}, byDevice: {}, botHits: {}, byHostKind: {} };
  for (const [f, v] of Object.entries(hash)) {
    const n = Number(v) || 0;
    if (f === "req") t.requests = n;
    else if (f === "pv") t.pageviews = n;
    else if (f === "enq") t.enquiries = n;
    else if (f.startsWith("src:")) t.bySource[f.slice(4)] = n;
    else if (f.startsWith("ref:")) t.byReferrer[f.slice(4)] = n;
    else if (f.startsWith("page:")) t.byPage[f.slice(5)] = n;
    else if (f.startsWith("dev:")) t.byDevice[f.slice(4)] = n;
    else if (f.startsWith("bot:")) t.botHits[f.slice(4)] = n;
    else if (f.startsWith("hk:")) t.byHostKind[f.slice(3)] = n;
  }
  return t;
}

/**
 * Copy today's and yesterday's counters for storefronts with activity since the last flush into
 * StorefrontTrafficDaily. Idempotent: rows are SET to the absolute Redis totals, so replays converge.
 * A slug that fails to persist is left in the "flushing" set and retried next run.
 */
export async function flushTraffic(now: Date = new Date()): Promise<{ flushed: number; skipped: number }> {
  let flushed = 0;
  let skipped = 0;
  const days = [dayKey(now), dayKey(new Date(now.getTime() - 24 * 3600_000))];
  for (const day of days) {
    // atomic hand-off: everything marked dirty so far (+ leftovers from a crashed run) becomes the batch
    await redis.multi().sunionstore(keys.flushing(day), keys.flushing(day), keys.dirty(day)).del(keys.dirty(day)).exec();
    const slugs = await redis.smembers(keys.flushing(day));
    if (!slugs.length) continue;
    const rows = await prisma.storefront.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
    for (const slug of slugs) {
      const storefrontId = idBySlug.get(slug);
      if (!storefrontId) {
        skipped++;
        await redis.srem(keys.flushing(day), slug);
        continue;
      }
      try {
        const [hash, uniques] = await Promise.all([redis.hgetall(keys.hash(day, slug)), redis.pfcount(keys.hll(day, slug))]);
        const t = totalsFromHash(hash, uniques);
        const data = {
          requests: t.requests,
          pageviews: t.pageviews,
          uniqueVisitors: t.uniqueVisitors,
          bySource: t.bySource,
          byReferrer: t.byReferrer,
          byPage: t.byPage,
          byDevice: t.byDevice,
          botHits: t.botHits,
          byHostKind: t.byHostKind,
          enquiries: t.enquiries,
        };
        await prisma.storefrontTrafficDaily.upsert({
          where: { storefrontId_day: { storefrontId, day: new Date(`${day}T00:00:00.000Z`) } },
          create: { storefrontId, day: new Date(`${day}T00:00:00.000Z`), ...data },
          update: data,
        });
        await redis.srem(keys.flushing(day), slug);
        flushed++;
      } catch (err) {
        console.error(`[domains] flush ${slug}/${day} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { flushed, skipped };
}
