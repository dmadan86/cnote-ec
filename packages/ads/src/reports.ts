// Reporting (design 5.7): cost per enquiry first, and never a click count without its invalid share.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { DAY_MS, istDate } from "./time";

export interface CampaignReport {
  campaignId: string;
  from: string;
  to: string;
  impressions: number;
  clicks: { valid: number; pending: number; invalid: number; self: number; total: number; invalidSharePct: number; invalidByReason: Record<string, number> };
  ctrPct: number;
  spendPaise: number;
  refundedPaise: number;
  avgCpcPaise: number;
  attributedEnquiries: number;
  costPerEnquiryPaise: number | null;
  lostImpressionShare: { budgetPct: number; qualityPct: number };
  daily: { date: string; impressions: number; validClicks: number; spendPaise: number }[];
}

/** `sellerBusinessId` enforces ownership for seller callers; pass null from admin. */
export async function getCampaignReport(sellerBusinessId: string | null, campaignId: string, days = 30, now = new Date()): Promise<CampaignReport> {
  const c = await prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { sellerBusinessId: true } });
  if (!c) throw new DomainError("not_found", "Campaign not found", undefined, "ads.campaignNotFound");
  if (sellerBusinessId && c.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your campaign", undefined, "ads.notCampaign");
  const from = new Date(now.getTime() - Math.min(Math.max(days, 1), 365) * DAY_MS);
  const [clicks, rollups, attributions] = await Promise.all([
    prisma.adClick.findMany({ where: { campaignId, createdAt: { gte: from } }, select: { validity: true, invalidReason: true, chargedPaise: true, createdAt: true, settlementId: true } }),
    prisma.adImpressionRollup.findMany({ where: { campaignId, hour: { gte: from } } }),
    prisma.adAttribution.count({ where: { campaignId, createdAt: { gte: from } } }),
  ]);
  const by = { valid: 0, pending: 0, invalid: 0, self: 0 };
  const invalidByReason: Record<string, number> = {};
  let spend = 0;
  let refunded = 0;
  const daily = new Map<string, { date: string; impressions: number; validClicks: number; spendPaise: number }>();
  const day = (d: Date) => {
    const k = istDate(d);
    const cur = daily.get(k) ?? { date: k, impressions: 0, validClicks: 0, spendPaise: 0 };
    daily.set(k, cur);
    return cur;
  };
  for (const k of clicks) {
    if (k.validity === "valid") {
      by.valid++;
      spend += Number(k.chargedPaise);
      const d = day(k.createdAt);
      d.validClicks++;
      d.spendPaise += Number(k.chargedPaise);
    } else if (k.validity === "pending") by.pending++;
    else if (k.validity === "self_click") by.self++;
    else {
      by.invalid++;
      const r = k.invalidReason ?? "other";
      invalidByReason[r] = (invalidByReason[r] ?? 0) + 1;
      if (k.settlementId) refunded += Number(k.chargedPaise);
    }
  }
  let impressions = 0;
  let lostB = 0;
  let lostQ = 0;
  for (const r of rollups) {
    impressions += r.served;
    lostB += r.lostBudget;
    lostQ += r.lostQuality;
    day(r.hour).impressions += r.served;
  }
  const total = clicks.length;
  const opportunities = impressions + lostB + lostQ;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    campaignId,
    from: from.toISOString(),
    to: now.toISOString(),
    impressions,
    clicks: { ...by, total, invalidSharePct: pct(by.invalid + by.self, total), invalidByReason },
    ctrPct: pct(by.valid + by.pending, impressions),
    spendPaise: spend,
    refundedPaise: refunded,
    avgCpcPaise: by.valid ? Math.round(spend / by.valid) : 0,
    attributedEnquiries: attributions,
    costPerEnquiryPaise: attributions ? Math.round(spend / attributions) : null,
    lostImpressionShare: { budgetPct: pct(lostB, opportunities), qualityPct: pct(lostQ, opportunities) },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getAdvertiserOverview(sellerBusinessId: string, days = 30, now = new Date()) {
  const campaigns = await prisma.adCampaign.findMany({ where: { sellerBusinessId }, select: { id: true, name: true, status: true } });
  const reports = await Promise.all(campaigns.map((c) => getCampaignReport(sellerBusinessId, c.id, days, now)));
  return campaigns.map((c, i) => ({ id: c.id, name: c.name, status: c.status, report: reports[i]! }));
}
