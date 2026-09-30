// Settlement, impression rollups and money-side monitors (design 5.8, 7.7, 10).
import { debitSpendTx, getAdWalletBalance, getNonAdRevenuePaise } from "@cnote/billing";
import { emit, redis } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getAdsConfig } from "./config";
import { DAY_MS, HOUR_MS, hourKey, hourStart, istDayStart } from "./time";
import { impKey, lostBudgetKey, lostQualityKey } from "./budget";

/**
 * Daily settlement: for every campaign, the valid, unsettled clicks created before the start of today (IST) become ONE ledger
 * debit and ONE AdSpendSettlement row, idempotent on (campaignId, windowStart = yesterday's IST midnight). Clicks that only became
 * valid after their day was settled (pending -> valid) are picked up by the next day's run. If the wallet is short the debit is
 * capped at the balance (never negative), the shortfall is absorbed by the platform and the campaign is halted for wallet by the sweep.
 */
export async function settleSpend(now = new Date()): Promise<{ settlements: number; spendPaise: number; shortfallPaise: number }> {
  const windowEnd = istDayStart(now);
  const windowStart = new Date(windowEnd.getTime() - DAY_MS);
  const groups = await prisma.adClick.groupBy({
    by: ["campaignId", "sellerBusinessId"],
    where: { validity: "valid", settlementId: null, createdAt: { lt: windowEnd } },
    _count: { _all: true },
  });
  let settlements = 0;
  let spend = 0;
  let shortfall = 0;
  for (const g of groups) {
    const done = await prisma.adSpendSettlement.findUnique({ where: { campaignId_windowStart: { campaignId: g.campaignId, windowStart } } });
    if (done) continue; // this window is already settled; late-valid clicks roll into tomorrow's window
    try {
      const r = await prisma.$transaction(async (tx) => {
        const clicks = await tx.adClick.findMany({ where: { campaignId: g.campaignId, validity: "valid", settlementId: null, createdAt: { lt: windowEnd } }, select: { id: true, chargedPaise: true } });
        if (!clicks.length) return null;
        const total = clicks.reduce((s, c) => s + Number(c.chargedPaise), 0);
        const s = await tx.adSpendSettlement.create({
          data: { campaignId: g.campaignId, sellerBusinessId: g.sellerBusinessId, windowStart, windowEnd, validClicks: clicks.length, spendPaise: BigInt(total) },
        });
        let debited = 0;
        let short = 0;
        if (total > 0) {
          const d = await debitSpendTx(tx, g.sellerBusinessId, total, { idempotencyKey: `settle:${g.campaignId}:${windowStart.toISOString()}`, refType: "ad_settlement", refId: s.id, allowPartial: true, now });
          debited = d.debitedPaise;
          short = d.shortfallPaise;
          if (d.entryId) await tx.adSpendSettlement.update({ where: { id: s.id }, data: { walletEntryId: d.entryId } });
        }
        await tx.adClick.updateMany({ where: { id: { in: clicks.map((c) => c.id) }, settlementId: null }, data: { settlementId: s.id } });
        await emit(tx, "AdSpendSettled", { type: "ad_campaign", id: g.campaignId }, {
          settlementId: s.id, campaignId: g.campaignId, sellerBusinessId: g.sellerBusinessId, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), validClicks: clicks.length, spendPaise: total,
        });
        return { debited, short };
      });
      if (r) {
        settlements++;
        spend += r.debited;
        shortfall += r.short;
      }
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue; // a concurrent run won
      throw err;
    }
  }
  return { settlements, spendPaise: spend, shortfallPaise: shortfall };
}

/**
 * Job: flushes the Redis served/lost buffers of finished hours into AdImpressionRollup (upsert with SET semantics, so a retry
 * is idempotent) and emits one AdImpressionsRolledUp event per (campaign, surface, hour), never per impression.
 */
export async function rollupImpressions(now = new Date()): Promise<{ hours: number; rows: number }> {
  let hours = 0;
  let rows = 0;
  for (let back = 1; back <= 3; back++) {
    const hour = new Date(hourStart(now).getTime() - back * HOUR_MS);
    const hk = hourKey(hour);
    if (await redis.exists(`ads:imp:done:${hk}`)) continue;
    const [served, lb, lq] = await Promise.all([redis.hgetall(impKey(hk)), redis.hgetall(lostBudgetKey(hk)), redis.hgetall(lostQualityKey(hk))]);
    const fields = new Set([...Object.keys(served), ...Object.keys(lb), ...Object.keys(lq)]);
    if (!fields.size) continue;
    const perCampaign = new Map<string, { campaignId: string; surface: string; served: number; lostBudget: number; lostQuality: number }>();
    for (const f of fields) {
      const [campaignId, listingId, categoryId, surface, slotRaw] = f.split("|") as [string, string, string, string, string];
      const slot = Number(slotRaw);
      const data = { served: Number(served[f] ?? 0), lostBudget: Number(lb[f] ?? 0), lostQuality: Number(lq[f] ?? 0) };
      await prisma.adImpressionRollup.upsert({
        where: { hour_campaignId_listingId_surface_slot: { hour, campaignId, listingId, surface: surface as Prisma.AdImpressionRollupUncheckedCreateInput["surface"], slot } },
        create: { hour, campaignId, listingId, categoryId: categoryId || null, surface: surface as Prisma.AdImpressionRollupUncheckedCreateInput["surface"], slot, ...data },
        update: data,
      });
      rows++;
      const k = `${campaignId}|${surface}`;
      const cur = perCampaign.get(k) ?? { campaignId, surface, served: 0, lostBudget: 0, lostQuality: 0 };
      cur.served += data.served;
      cur.lostBudget += data.lostBudget;
      cur.lostQuality += data.lostQuality;
      perCampaign.set(k, cur);
    }
    await prisma.$transaction(async (tx) => {
      for (const c of perCampaign.values()) await emit(tx, "AdImpressionsRolledUp", { type: "ad_campaign", id: c.campaignId }, { hour: hour.toISOString(), ...c });
    });
    await redis.set(`ads:imp:done:${hk}`, "1", "EX", 6 * 3600);
    hours++;
  }
  return { hours, rows };
}

/** Job: emits AdWalletLow (at most once per day per business) when the balance would not cover `walletLowDays` of average spend. */
export async function checkWalletLow(now = new Date()): Promise<number> {
  const cfg = await getAdsConfig(now.getTime());
  const advertisers = await prisma.adCampaign.findMany({ where: { status: { in: ["approved", "active", "exhausted"] } }, select: { sellerBusinessId: true }, distinct: ["sellerBusinessId"] });
  let alerts = 0;
  for (const { sellerBusinessId } of advertisers) {
    const week = await prisma.adSpendSettlement.aggregate({ _sum: { spendPaise: true }, where: { sellerBusinessId, windowStart: { gte: new Date(now.getTime() - 7 * DAY_MS) } } });
    const avgDaily = Number(week._sum.spendPaise ?? 0n) / 7;
    const threshold = Math.max(cfg.walletLowFloorPaise, Math.round(avgDaily * cfg.walletLowDays));
    const balance = await getAdWalletBalance(sellerBusinessId, now);
    if (balance >= threshold) continue;
    if ((await redis.set(`ads:walletlow:${sellerBusinessId}`, "1", "EX", DAY_MS / 1000, "NX")) !== "OK") continue;
    await prisma.$transaction((tx) => emit(tx, "AdWalletLow", { type: "business", id: sellerBusinessId }, { businessId: sellerBusinessId, balancePaise: balance, thresholdPaise: threshold }));
    alerts++;
  }
  return alerts;
}

export interface RevenueCapStatus {
  windowDays: number;
  adRevenuePaise: number;
  otherRevenuePaise: number;
  sharePct: number;
  capPct: number;
  breached: boolean;
}

/** Ads as a share of trailing-90-day revenue (ADR-024 rule 10). Monitoring alert only: nothing is switched off automatically. */
export async function getRevenueCapStatus(now = new Date()): Promise<RevenueCapStatus> {
  const cfg = await getAdsConfig(now.getTime());
  const from = new Date(now.getTime() - 90 * DAY_MS);
  const [ads, other] = await Promise.all([
    prisma.adSpendSettlement.aggregate({ _sum: { spendPaise: true }, where: { windowStart: { gte: from } } }),
    getNonAdRevenuePaise(from, now),
  ]);
  const adRevenuePaise = Number(ads._sum.spendPaise ?? 0n);
  const total = adRevenuePaise + other;
  const sharePct = total > 0 ? Math.round((adRevenuePaise / total) * 1000) / 10 : 0;
  return { windowDays: 90, adRevenuePaise, otherRevenuePaise: other, sharePct, capPct: cfg.revenueCapPct, breached: sharePct > cfg.revenueCapPct };
}

/** Job: logs (and records in Redis for the admin monitor) when the cap is breached. */
export async function checkRevenueCap(now = new Date()): Promise<RevenueCapStatus> {
  const s = await getRevenueCapStatus(now);
  await redis.set("ads:revenue-cap:last", JSON.stringify({ ...s, at: now.toISOString() }), "EX", 3 * DAY_MS / 1000);
  if (s.breached) console.error(`[ads] ALERT: ads are ${s.sharePct}% of trailing-90-day revenue (cap ${s.capPct}%). A founder decision is required (ADR-024 rule 10).`);
  return s;
}
