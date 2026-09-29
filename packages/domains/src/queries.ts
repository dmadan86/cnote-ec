import { prisma } from "@cnote/db";
import { dayKey } from "./metering";

export interface TrafficPoint {
  day: string;
  requests: number;
  pageviews: number;
  uniqueVisitors: number;
  botRequests: number;
  enquiries: number;
}
export interface Breakdown {
  key: string;
  count: number;
}
export interface TrafficSummary {
  from: string;
  to: string;
  totals: { requests: number; pageviews: number; uniqueVisitors: number; botHits: number; humanRequests: number; enquiries: number };
  series: TrafficPoint[];
  bySource: Breakdown[];
  byReferrer: Breakdown[];
  byPage: Breakdown[];
  byDevice: Breakdown[];
  bots: Breakdown[];
  byHostKind: Breakdown[];
}

type Counts = Record<string, number>;
const asCounts = (v: unknown): Counts => (v && typeof v === "object" ? (v as Counts) : {});
const sumInto = (acc: Counts, v: unknown) => {
  for (const [k, n] of Object.entries(asCounts(v))) acc[k] = (acc[k] ?? 0) + (Number(n) || 0);
};
const ranked = (c: Counts, top?: number): Breakdown[] => {
  const all = Object.entries(c).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  if (!top || all.length <= top) return all;
  const rest = all.slice(top).reduce((s, x) => s + x.count, 0);
  return [...all.slice(0, top), { key: "(other)", count: rest }];
};
const total = (c: Counts) => Object.values(c).reduce((s, n) => s + n, 0);

/** Inclusive range of IST days as YYYY-MM-DD strings. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`) && out.length < 400; d = new Date(d.getTime() + 86400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** Dashboard summary for a date range (defaults to the last 30 days, IST). Values are as of the last 5-minute flush. */
export async function getTrafficSummary(storefrontId: string, range: { from?: string; to?: string; days?: number } = {}): Promise<TrafficSummary> {
  const to = range.to ?? dayKey();
  const from = range.from ?? dayKey(new Date(Date.now() - ((range.days ?? 30) - 1) * 86400_000));
  const rows = await prisma.storefrontTrafficDaily.findMany({
    where: { storefrontId, day: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
    orderBy: { day: "asc" },
  });
  const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));
  const source: Counts = {}, ref: Counts = {}, page: Counts = {}, dev: Counts = {}, bots: Counts = {}, hk: Counts = {};
  const series: TrafficPoint[] = daysBetween(from, to).map((day) => {
    const r = byDay.get(day);
    if (r) {
      sumInto(source, r.bySource); sumInto(ref, r.byReferrer); sumInto(page, r.byPage); sumInto(dev, r.byDevice); sumInto(bots, r.botHits); sumInto(hk, r.byHostKind);
    }
    return { day, requests: r?.requests ?? 0, pageviews: r?.pageviews ?? 0, uniqueVisitors: r?.uniqueVisitors ?? 0, botRequests: r ? total(asCounts(r.botHits)) : 0, enquiries: r?.enquiries ?? 0 };
  });
  const sum = (k: keyof TrafficPoint) => series.reduce((s, p) => s + (p[k] as number), 0);
  return {
    from,
    to,
    // unique visitors per day are summed: a person returning on two days counts twice (no cross-day identity by design)
    totals: { requests: sum("requests"), pageviews: sum("pageviews"), uniqueVisitors: sum("uniqueVisitors"), botHits: sum("botRequests"), humanRequests: Math.max(0, sum("requests") - sum("botRequests")), enquiries: sum("enquiries") },
    series,
    bySource: ranked(source),
    byReferrer: ranked(ref, 15),
    byPage: ranked(page, 15),
    byDevice: ranked(dev),
    bots: ranked(bots, 15),
    byHostKind: ranked(hk),
  };
}

/** Same summary, addressed by the seller's business. Null when the seller has no storefront. */
export async function getTrafficSummaryForSeller(sellerBusinessId: string, range: { from?: string; to?: string; days?: number } = {}): Promise<TrafficSummary | null> {
  const sf = await prisma.storefront.findUnique({ where: { sellerBusinessId }, select: { id: true } });
  return sf ? getTrafficSummary(sf.id, range) : null;
}

/** Metering for billing: total requests served for a storefront in [from, to] (IST days, inclusive). */
export async function getMeteredRequests(storefrontId: string, from: string, to: string): Promise<number> {
  const a = await prisma.storefrontTrafficDaily.aggregate({ where: { storefrontId, day: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } }, _sum: { requests: true } });
  return a._sum.requests ?? 0;
}
