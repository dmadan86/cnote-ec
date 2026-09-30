// Redis state for serving: budget pacing counters, frequency caps, impression buffers, kill switches (design 7.7).
// The daily budget counter is the ONLY thing that decides whether a click may be charged, and it is atomic (Lua),
// so N parallel clicks can never take a campaign past its daily (or total) budget.
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hourKey, istDate, istDayStart } from "./time";

const DAY_S = 86_400;
export const budgetKey = (campaignId: string, date: string) => `ads:budget:${campaignId}:${date}`;
export const totalKey = (campaignId: string) => `ads:total:${campaignId}`;
export const freqKey = (visitor: string, listingId: string) => `ads:freq:${visitor}:${listingId}`;
export const killKey = (scope: string) => `ads:kill:${scope}`;

const RESERVE = `
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
local t = tonumber(redis.call('GET', KEYS[2]) or '0')
local amt = tonumber(ARGV[1])
if d + amt > tonumber(ARGV[2]) then return {0, d, t, 1} end
if tonumber(ARGV[3]) >= 0 and t + amt > tonumber(ARGV[3]) then return {0, d, t, 2} end
redis.call('INCRBY', KEYS[1], amt)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('INCRBY', KEYS[2], amt)
return {1, d + amt, t + amt, 0}
`;

const RELEASE = `
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
local t = tonumber(redis.call('GET', KEYS[2]) or '0')
local amt = tonumber(ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('SET', KEYS[1], math.max(0, d - amt), 'KEEPTTL') end
redis.call('SET', KEYS[2], math.max(0, t - amt), 'KEEPTTL')
return 1
`;

/** After a Redis flush the counters restart at 0, which would let a campaign overspend: re-seed from the click table once. */
export async function ensureBudgetSeeded(campaignId: string, at: Date): Promise<void> {
  const date = istDate(at);
  const [hasDay, hasTotal] = await Promise.all([redis.exists(budgetKey(campaignId, date)), redis.exists(totalKey(campaignId))]);
  if (hasDay && hasTotal) return;
  const where = { campaignId, validity: { in: ["valid", "pending"] as ("valid" | "pending")[] } };
  if (!hasDay) {
    const day = await prisma.adClick.aggregate({ _sum: { chargedPaise: true }, where: { ...where, createdAt: { gte: istDayStart(at) } } });
    await redis.set(budgetKey(campaignId, date), String(Number(day._sum.chargedPaise ?? 0n)), "EX", 36 * 3600, "NX");
  }
  if (!hasTotal) {
    const all = await prisma.adClick.aggregate({ _sum: { chargedPaise: true }, where });
    await redis.set(totalKey(campaignId), String(Number(all._sum.chargedPaise ?? 0n)), "NX");
  }
}

export type ReserveResult = { ok: true; dailySpent: number } | { ok: false; reason: "daily_budget" | "total_budget" };

export async function reserveSpend(o: { campaignId: string; dailyBudgetPaise: number; totalBudgetPaise: number | null; amountPaise: number; at: Date }): Promise<ReserveResult> {
  await ensureBudgetSeeded(o.campaignId, o.at);
  const res = (await redis.eval(RESERVE, 2, budgetKey(o.campaignId, istDate(o.at)), totalKey(o.campaignId), o.amountPaise, o.dailyBudgetPaise, o.totalBudgetPaise ?? -1, 36 * 3600)) as number[];
  return res[0] === 1 ? { ok: true, dailySpent: res[1]! } : { ok: false, reason: res[3] === 1 ? "daily_budget" : "total_budget" };
}

export async function releaseSpend(campaignId: string, amountPaise: number, at: Date): Promise<void> {
  await redis.eval(RELEASE, 2, budgetKey(campaignId, istDate(at)), totalKey(campaignId), amountPaise);
}

/** Spent today per campaign (one MGET). */
export async function getSpentToday(campaignIds: string[], at: Date): Promise<Map<string, { day: number; total: number }>> {
  const out = new Map<string, { day: number; total: number }>();
  if (!campaignIds.length) return out;
  const date = istDate(at);
  const vals = await redis.mget(...campaignIds.map((c) => budgetKey(c, date)), ...campaignIds.map(totalKey));
  campaignIds.forEach((c, i) => out.set(c, { day: Number(vals[i] ?? 0), total: Number(vals[campaignIds.length + i] ?? 0) }));
  return out;
}

// ---- kill switches (no deploy needed) ----
export async function setKillSwitch(scope: "all" | "search" | "category" | "product_similar", on: boolean): Promise<void> {
  if (on) await redis.set(killKey(scope), "1");
  else await redis.del(killKey(scope));
}

export async function getKillSwitches(): Promise<Record<string, boolean>> {
  const scopes = ["all", "search", "category", "product_similar"];
  const vals = await redis.mget(...scopes.map(killKey));
  return Object.fromEntries(scopes.map((s, i) => [s, vals[i] === "1"]));
}

// ---- impressions (served counts buffered in Redis, rolled up hourly) ----
export const impKey = (hour: string) => `ads:imp:${hour}`;
export const lostBudgetKey = (hour: string) => `ads:lostb:${hour}`;
export const lostQualityKey = (hour: string) => `ads:lostq:${hour}`;
export const impField = (campaignId: string, listingId: string, categoryId: string | null, surface: string, slot: number) => `${campaignId}|${listingId}|${categoryId ?? ""}|${surface}|${slot}`;

export async function bufferImpressions(o: {
  at: Date;
  served: { campaignId: string; listingId: string; categoryId: string | null; surface: string; slot: number }[];
  lostBudget: { campaignId: string; listingId: string; categoryId: string | null; surface: string }[];
  lostQuality: { campaignId: string; listingId: string; categoryId: string | null; surface: string }[];
  frequency: { visitor: string; listingId: string; windowSeconds: number }[];
}): Promise<void> {
  const hour = hourKey(o.at);
  const pipe = redis.pipeline();
  for (const s of o.served) pipe.hincrby(impKey(hour), impField(s.campaignId, s.listingId, s.categoryId, s.surface, s.slot), 1);
  for (const s of o.lostBudget) pipe.hincrby(lostBudgetKey(hour), impField(s.campaignId, s.listingId, s.categoryId, s.surface, 0), 1);
  for (const s of o.lostQuality) pipe.hincrby(lostQualityKey(hour), impField(s.campaignId, s.listingId, s.categoryId, s.surface, 0), 1);
  for (const k of [impKey(hour), lostBudgetKey(hour), lostQualityKey(hour)]) pipe.expire(k, 4 * 3600);
  for (const f of o.frequency) pipe.incr(freqKey(f.visitor, f.listingId)).expire(freqKey(f.visitor, f.listingId), f.windowSeconds > 0 ? f.windowSeconds : DAY_S);
  await pipe.exec();
}
