// Click recording, invalid-click filtering, 72 h re-scoring and enquiry attribution (design 5.6, 5.7).
//  - `recordClick(token)` is the ONLY place a click is created. The token is HMAC-signed and single-use (unique tokenId).
//  - Real-time rules label a click `valid` (charged, settled daily), `pending` (suspicious, not charged until the
//    re-score resolves it), `invalid` or `self_click` (never charged).
//  - Only `valid` clicks are ever debited. A click found invalid after settlement is refunded automatically (no ticket).
//  - The daily budget is enforced with an atomic Redis counter, so parallel clicks can never exceed it.
import { getAdWalletBalanceTx, refundInvalidClickTx } from "@cnote/billing";
import { getListingsByIds } from "@cnote/catalogue";
import { emit, redis } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { isBusinessMember } from "@cnote/identity";
import { releaseSpend, reserveSpend } from "./budget";
import { getAdsConfig, type AdsConfig } from "./config";
import { hashNet, hashVisitor, verifyClickToken } from "./tokens";
import { DAY_MS, HOUR_MS, hourKey } from "./time";

export interface ClickContext {
  visitorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** signed-in buyer, when known */
  personId?: string | null;
  businessId?: string | null;
  now?: Date;
}

export type ClickOutcome =
  | { status: "recorded"; listingId: string; clickId: string; validity: "valid" | "pending" | "invalid" | "self_click"; chargedPaise: number; invalidReason?: string }
  | { status: "replay" | "expired"; listingId: string }
  | { status: "invalid_token" };

export function classifyUserAgent(ua: string | null | undefined, patterns: string[]): "browser" | "app" | "bot" | "unknown" {
  if (!ua || !ua.trim()) return "unknown";
  const s = ua.toLowerCase();
  if (patterns.some((p) => s.includes(p.toLowerCase()))) return "bot";
  if (/cnote-app|cnote\/\d/.test(s)) return "app";
  return s.includes("mozilla/") ? "browser" : "unknown";
}

/** Real-time verdict from cheap signals. Pure so the rules are unit-testable. */
export function realtimeVerdict(s: { uaClass: string; self: boolean; duplicate: boolean; netBurst: boolean; velocity: boolean }): { validity: "valid" | "pending" | "invalid" | "self_click"; reason?: string } {
  if (s.self) return { validity: "self_click", reason: "self" };
  if (s.uaClass === "bot" || s.uaClass === "unknown") return { validity: "invalid", reason: "bot_ua" };
  if (s.duplicate) return { validity: "invalid", reason: "duplicate" };
  if (s.netBurst) return { validity: "pending", reason: "ip_burst" };
  if (s.velocity) return { validity: "pending", reason: "click_velocity" };
  return { validity: "valid" };
}

export async function recordClick(token: string, ctx: ClickContext = {}): Promise<ClickOutcome> {
  const now = ctx.now ?? new Date();
  const cfg = await getAdsConfig(now.getTime());
  const v = verifyClickToken(token, cfg.tokenTtlMinutes, now.getTime());
  if (!v.ok) return { status: "invalid_token" };
  const p = v.payload;
  if (v.expired) return { status: "expired", listingId: p.l };

  const visitorKey = ctx.visitorId ?? `${ctx.ip ?? "ip"}|${ctx.userAgent ?? "ua"}`;
  const visitorHash = hashVisitor(visitorKey, now);
  const netHash = hashNet(ctx.ip, now);
  const uaClass = classifyUserAgent(ctx.userAgent, cfg.botUserAgentPatterns);

  const self = (!!ctx.businessId && ctx.businessId === p.s) || (!!ctx.personId && (await isBusinessMember(ctx.personId, p.s).catch(() => false)));
  const dedupeSet = await redis.set(`ads:click:seen:${visitorHash}:${p.c}:${p.l}`, "1", "EX", cfg.clickDedupeMinutes * 60, "NX");
  const netCount = await redis.incr(`ads:click:net:${netHash}:${p.c}:${hourKey(now)}`);
  if (netCount === 1) await redis.expire(`ads:click:net:${netHash}:${p.c}:${hourKey(now)}`, 2 * 3600);
  const minute = Math.floor(now.getTime() / 60_000);
  const velocity = await redis.incr(`ads:click:vel:${p.c}:${minute}`);
  if (velocity === 1) await redis.expire(`ads:click:vel:${p.c}:${minute}`, 180);

  let verdict = realtimeVerdict({ uaClass, self, duplicate: dedupeSet !== "OK", netBurst: netCount > cfg.clickBurstPerNetHour, velocity: velocity > cfg.campaignClicksPerMinute });
  let reserved = 0;
  const campaign = await prisma.adCampaign.findUnique({ where: { id: p.c }, select: { dailyBudgetPaise: true, totalBudgetPaise: true, status: true } });
  if (!campaign) return { status: "invalid_token" };

  if (verdict.validity === "valid" || verdict.validity === "pending") {
    if (campaign.status === "suspended" || campaign.status === "rejected" || campaign.status === "ended") verdict = { validity: "invalid", reason: "campaign_inactive" };
    else {
      const r = await reserveSpend({ campaignId: p.c, dailyBudgetPaise: Number(campaign.dailyBudgetPaise), totalBudgetPaise: campaign.totalBudgetPaise === null ? null : Number(campaign.totalBudgetPaise), amountPaise: p.p, at: now });
      if (r.ok) reserved = p.p;
      else verdict = { validity: "invalid", reason: "over_budget" }; // never charge past the budget; the platform absorbs the overshoot
    }
  }

  try {
    const click = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"adclick:" + p.s}))`;
      if (reserved > 0) {
        // wallet headroom: balance minus clicks already accepted but not yet settled (serialised per seller)
        const exposure = await tx.adClick.aggregate({ _sum: { chargedPaise: true }, where: { sellerBusinessId: p.s, validity: { in: ["valid", "pending"] }, settlementId: null } });
        const headroom = (await getAdWalletBalanceTx(tx, p.s, now)) - Number(exposure._sum.chargedPaise ?? 0n);
        if (headroom < p.p) verdict = { validity: "invalid", reason: "wallet_empty" };
      }
      const row = await tx.adClick.create({
        data: {
          campaignId: p.c,
          adGroupId: p.g,
          listingId: p.l,
          sellerBusinessId: p.s,
          surface: p.f as Prisma.AdClickUncheckedCreateInput["surface"],
          slot: p.n,
          chargedPaise: BigInt(p.p),
          validity: verdict.validity,
          invalidReason: verdict.reason ?? null,
          visitorHash,
          buyerPersonId: ctx.personId ?? null,
          buyerBusinessId: ctx.businessId ?? null,
          netHash,
          userAgentClass: uaClass,
          queryNormalised: p.q,
          tokenId: p.t,
          createdAt: now,
        },
      });
      await emit(tx, "AdClicked", { type: "ad_campaign", id: p.c }, {
        clickId: row.id, campaignId: p.c, adGroupId: p.g, listingId: p.l, sellerBusinessId: p.s, surface: p.f, slot: p.n, chargedPaise: p.p, validity: verdict.validity,
        ...(verdict.reason ? { invalidReason: verdict.reason } : {}),
      });
      return row;
    });
    const charged = verdict.validity === "valid" || verdict.validity === "pending";
    if (reserved > 0 && !charged) await releaseSpend(p.c, reserved, now); // wallet check failed after the reservation
    return { status: "recorded", listingId: p.l, clickId: click.id, validity: verdict.validity, chargedPaise: verdict.validity === "valid" ? p.p : 0, ...(verdict.reason ? { invalidReason: verdict.reason } : {}) };
  } catch (err) {
    if (reserved > 0) await releaseSpend(p.c, reserved, now);
    if ((err as { code?: string }).code === "P2002") return { status: "replay", listingId: p.l }; // token already used: redirect, never charge twice
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Invalidation + refunds
// ---------------------------------------------------------------------------------------------------------------

/** Marks one click invalid. If it was already settled the charge is refunded to the wallet automatically (idempotent). */
export async function invalidateClick(clickId: string, reason: string, source: "rules" | "rescore" | "staff", now = new Date()): Promise<{ refundedPaise: number; changed: boolean }> {
  const out = await prisma.$transaction(async (tx) => {
    const c = await tx.adClick.findUnique({ where: { id: clickId } });
    if (!c || c.validity === "invalid" || c.validity === "self_click") return { refundedPaise: 0, changed: false, click: c };
    let refunded = 0;
    if (c.validity === "valid" && c.settlementId) {
      await refundInvalidClickTx(tx, c.sellerBusinessId, c.id, Number(c.chargedPaise));
      refunded = Number(c.chargedPaise);
    }
    await tx.adClick.update({ where: { id: c.id }, data: { validity: "invalid", invalidReason: reason, rescoredAt: now } });
    await emit(tx, "AdClickInvalidated", { type: "ad_campaign", id: c.campaignId }, { clickId: c.id, campaignId: c.campaignId, sellerBusinessId: c.sellerBusinessId, reason, refundedPaise: refunded, source });
    return { refundedPaise: refunded, changed: true, click: c };
  });
  if (out.changed && out.click) await releaseSpend(out.click.campaignId, Number(out.click.chargedPaise), out.click.createdAt).catch(() => undefined);
  return { refundedPaise: out.refundedPaise, changed: out.changed };
}

/** Staff fraud review: invalidate (and refund) a batch. The admin action wraps this in audited(). */
export async function invalidateClicksByStaff(clickIds: string[], reason: string): Promise<{ invalidated: number; refundedPaise: number }> {
  let invalidated = 0;
  let refundedPaise = 0;
  for (const id of clickIds) {
    const r = await invalidateClick(id, reason, "staff");
    if (r.changed) invalidated++;
    refundedPaise += r.refundedPaise;
  }
  return { invalidated, refundedPaise };
}

/** Retroactive rules that need history: network clusters and repeat visitors. Returns a reason when the click should be invalid. */
export async function retroReason(c: { id: string; campaignId: string; listingId: string; netHash: string; visitorHash: string; createdAt: Date }, cfg: AdsConfig): Promise<string | null> {
  const since = new Date(c.createdAt.getTime() - DAY_MS);
  const [net, visitor] = await Promise.all([
    prisma.adClick.count({ where: { campaignId: c.campaignId, netHash: c.netHash, createdAt: { gte: since, lt: c.createdAt }, validity: { in: ["valid", "pending"] } } }),
    prisma.adClick.count({ where: { visitorHash: c.visitorHash, listingId: c.listingId, createdAt: { gte: since, lt: c.createdAt }, validity: { in: ["valid", "pending"] } } }),
  ]);
  if (net >= cfg.netDailyCap) return "ip_cluster";
  if (visitor >= cfg.visitorDailyCap) return "repeat_visitor";
  return null;
}

/**
 * Job: re-scores clicks inside the re-score window (default 72 h, the same window as the lead refund).
 * Invalid -> marked and refunded if settled. Pending and old enough -> valid. Idempotent.
 */
export async function rescoreClicks(now = new Date(), batch = 500): Promise<{ scanned: number; invalidated: number; promoted: number }> {
  const cfg = await getAdsConfig(now.getTime());
  const windowStart = new Date(now.getTime() - cfg.invalidClickRescoreHours * HOUR_MS);
  const minAge = new Date(now.getTime() - cfg.rescoreMinAgeHours * HOUR_MS);
  const clicks = await prisma.adClick.findMany({
    where: { validity: { in: ["valid", "pending"] }, createdAt: { gte: windowStart, lte: minAge } },
    orderBy: { createdAt: "asc" },
    take: batch,
  });
  let invalidated = 0;
  let promoted = 0;
  for (const c of clicks) {
    const reason = await retroReason(c, cfg);
    if (reason) {
      if ((await invalidateClick(c.id, reason, "rescore", now)).changed) invalidated++;
    } else if (c.validity === "pending") {
      await prisma.adClick.update({ where: { id: c.id }, data: { validity: "valid", invalidReason: null, rescoredAt: now } });
      promoted++;
    } else {
      await prisma.adClick.update({ where: { id: c.id }, data: { rescoredAt: now } });
    }
  }
  return { scanned: clicks.length, invalidated, promoted };
}

// ---------------------------------------------------------------------------------------------------------------
// Attribution (click -> enquiry within the window, last click)
// ---------------------------------------------------------------------------------------------------------------

export interface AttributeInput {
  enquiryId: string;
  buyerBusinessId?: string | null;
  buyerPersonId?: string | null;
  /** listing the enquiry is about, when known */
  listingId?: string | null;
  /** enquiry category, used when no listing is known */
  categoryId?: string | null;
  /** click id carried by the short-lived attribution cookie, when present */
  clickId?: string | null;
  now?: Date;
}

/** Last valid/pending click by the same buyer within the window. Idempotent per enquiry (unique enquiryId). */
export async function attributeEnquiry(i: AttributeInput): Promise<{ attributionId: string; clickId: string } | null> {
  const now = i.now ?? new Date();
  const cfg = await getAdsConfig(now.getTime());
  const since = new Date(now.getTime() - cfg.attributionWindowDays * DAY_MS);
  const existing = await prisma.adAttribution.findUnique({ where: { enquiryId: i.enquiryId } });
  if (existing) return { attributionId: existing.id, clickId: existing.clickId };

  const base: Prisma.AdClickWhereInput = { validity: { in: ["valid", "pending"] }, createdAt: { gte: since, lte: now }, ...(i.listingId ? { listingId: i.listingId } : {}) };
  let click: Awaited<ReturnType<typeof prisma.adClick.findFirst>> = null;
  if (i.clickId) {
    click = await prisma.adClick.findFirst({ where: { ...base, id: i.clickId, OR: [{ buyerBusinessId: null }, { buyerBusinessId: i.buyerBusinessId ?? "-" }] } });
  } else if (i.buyerBusinessId || i.buyerPersonId) {
    const who: Prisma.AdClickWhereInput[] = [];
    if (i.buyerBusinessId) who.push({ buyerBusinessId: i.buyerBusinessId });
    if (i.buyerPersonId) who.push({ buyerPersonId: i.buyerPersonId });
    const recent = await prisma.adClick.findMany({ where: { ...base, OR: who }, orderBy: { createdAt: "desc" }, take: 20 });
    if (!i.listingId && i.categoryId) {
      const listings = new Map((await getListingsByIds(recent.map((r) => r.listingId))).map((l) => [l.id, l.category.id]));
      click = recent.find((r) => listings.get(r.listingId) === i.categoryId) ?? null;
    } else click = recent[0] ?? null;
  }
  if (!click) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      const a = await tx.adAttribution.create({
        data: { clickId: click.id, enquiryId: i.enquiryId, campaignId: click.campaignId, listingId: click.listingId, lagSeconds: Math.max(0, Math.round((now.getTime() - click.createdAt.getTime()) / 1000)) },
      });
      await emit(tx, "AdAttributionRecorded", { type: "ad_campaign", id: click.campaignId }, { attributionId: a.id, clickId: click.id, campaignId: click.campaignId, listingId: click.listingId, enquiryId: i.enquiryId, lagSeconds: a.lagSeconds });
      return { attributionId: a.id, clickId: click.id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const a = await prisma.adAttribution.findUnique({ where: { enquiryId: i.enquiryId } });
      return a ? { attributionId: a.id, clickId: a.clickId } : null;
    }
    throw err;
  }
}
