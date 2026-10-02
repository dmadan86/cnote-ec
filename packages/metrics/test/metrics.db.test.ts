import { prisma } from "@cnote/db";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { backfill, computeDay, countOpenAlerts, getDimensionBreakdown, getMetricSeries, getScorecard, listAlerts, resolveAlert } from "../src";
import { DAY, HOUR, MIN, at, cleanup, ev, insert, row } from "./helpers";

beforeAll(() => cleanup());
afterEach(() => cleanup());

const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const NOW = new Date("2001-12-31T00:00:00Z"); // every 2001 day is matured

async function val(metric: string, day: string, dimension = "") {
  const r = await row(metric, day, dimension);
  return r ? { value: r.value, num: r.numerator, den: r.denominator } : null;
}

describe("funnel metrics (exact numerator/denominator)", () => {
  it("lead_to_conversation_rate: 7-day window, dedups matches, category dimension", async () => {
    const d = "2001-01-10";
    await insert([
      ev("EnquiryCreated", { enquiryId: "e1", categoryId: "cat-a", buyerBusinessId: "b" }, at(d, "09:00")),
      ev("EnquiryCreated", { enquiryId: "e2", categoryId: "cat-a", buyerBusinessId: "b" }, at(d, "09:00")),
      ev("EnquiryCreated", { enquiryId: "e3", categoryId: "cat-b", buyerBusinessId: "b" }, at(d, "09:00")),
      ev("LeadMatched", { enquiryId: "e1", matchId: "m1" }, at(d)),
      ev("LeadMatched", { enquiryId: "e1", matchId: "m1" }, at(d, "10:05")), // duplicate delivery
      ev("LeadMatched", { enquiryId: "e2", matchId: "m2" }, at(d)),
      ev("LeadMatched", { enquiryId: "e3", matchId: "m3" }, at(d)),
      ev("LeadMatched", { enquiryId: "e4", matchId: "m4" }, at(d)), // enquiry created earlier than lookback: category none
      ev("ConversationStarted", { conversationId: "c1", matchId: "m1" }, at(d, "10:00", HOUR)),
      ev("ConversationStarted", { conversationId: "c2", matchId: "m2" }, at(d, "10:00", 6 * DAY)),
      ev("ConversationStarted", { conversationId: "c3", matchId: "m3" }, at(d, "10:00", 8 * DAY)), // outside 7d
      ev("ConversationStarted", { conversationId: "c9", matchId: "unrelated" }, at(d, "10:00", HOUR)),
    ]);
    await computeDay(d, { only: ["lead_to_conversation_rate"] });
    expect(await val("lead_to_conversation_rate", d)).toEqual({ value: 0.5, num: 2, den: 4 });
    expect(await val("lead_to_conversation_rate", d, "category:cat-a")).toEqual({ value: 1, num: 2, den: 2 });
    expect(await val("lead_to_conversation_rate", d, "category:cat-b")).toEqual({ value: 0, num: 0, den: 1 });
    expect(await val("lead_to_conversation_rate", d, "category:none")).toEqual({ value: 0, num: 0, den: 1 });
    const br = await getDimensionBreakdown("lead_to_conversation_rate", { from: d, to: d });
    expect(br.map((b) => b.dimension).sort()).toEqual(["category:cat-a", "category:cat-b", "category:none"]);
    expect(br[0]).toMatchObject({ dimension: "category:cat-a", value: 1, denominator: 2 });
  });

  it("conversation_to_deal_rate: only 'won' within 30 days", async () => {
    const d = "2001-01-11";
    await insert([
      ev("ConversationStarted", { conversationId: "c1", matchId: "m1" }, at(d)),
      ev("ConversationStarted", { conversationId: "c2", matchId: "m2" }, at(d)),
      ev("ConversationStarted", { conversationId: "c3", matchId: "m3" }, at(d)),
      ev("ConversationStarted", { conversationId: "c4", matchId: "m4" }, at(d)),
      ev("DealReportedOffPlatform", { matchId: "m1", reportedByBusinessId: "s", outcome: "won" }, at(d, "10:00", 3 * DAY)),
      ev("DealReportedOffPlatform", { matchId: "m2", reportedByBusinessId: "s", outcome: "lost" }, at(d, "10:00", 3 * DAY)),
      ev("DealReportedOffPlatform", { matchId: "m3", reportedByBusinessId: "s", outcome: "won" }, at(d, "10:00", 31 * DAY)),
    ]);
    await computeDay(d, { only: ["conversation_to_deal_rate"] });
    expect(await val("conversation_to_deal_rate", d)).toEqual({ value: 0.25, num: 1, den: 4 });
  });

  it("auto_refund_rate: refunded / accepted, 14-day window", async () => {
    const d = "2001-01-12";
    await insert([
      ...many(5, (i) => ev("LeadAccepted", { enquiryId: "e", matchId: `m${i}`, sellerBusinessId: "s", creditTxnId: null, responseMs: 1 }, at(d))),
      ev("LeadRefunded", { enquiryId: "e", matchId: "m0", sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "12:00")),
      ev("LeadRefunded", { enquiryId: "e", matchId: "m0", sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "12:30")), // duplicate
      ev("LeadRefunded", { enquiryId: "e", matchId: "m1", sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "10:00", 20 * DAY)), // late
    ]);
    await computeDay(d, { only: ["auto_refund_rate"] });
    expect(await val("auto_refund_rate", d)).toEqual({ value: 0.2, num: 1, den: 5 });
  });

  it("leads_per_enquiry: matches per enquiry created on the day", async () => {
    const d = "2001-01-13";
    await insert([
      ev("EnquiryCreated", { enquiryId: "e1", categoryId: "c", buyerBusinessId: "b" }, at(d)),
      ev("EnquiryCreated", { enquiryId: "e2", categoryId: "c", buyerBusinessId: "b" }, at(d)),
      ev("LeadMatched", { enquiryId: "e1", matchId: "m1", sellerBusinessId: "s", rank: 1, matchScore: 1 }, at(d, "10:00", MIN)),
      ev("LeadMatched", { enquiryId: "e1", matchId: "m2", sellerBusinessId: "s", rank: 2, matchScore: 1 }, at(d, "10:00", MIN)),
      ev("LeadMatched", { enquiryId: "e2", matchId: "m3", sellerBusinessId: "s", rank: 1, matchScore: 1 }, at(d, "10:00", DAY)),
      ev("LeadMatched", { enquiryId: "e2", matchId: "m4", sellerBusinessId: "s", rank: 2, matchScore: 1 }, at(d, "10:00", 5 * DAY)), // beyond window
    ]);
    await computeDay(d, { only: ["leads_per_enquiry"] });
    expect(await val("leads_per_enquiry", d)).toEqual({ value: 1.5, num: 3, den: 2 });
    expect(await val("leads_per_enquiry", d, "category:c")).toEqual({ value: 1.5, num: 3, den: 2 });
  });

  it("median_lead_response_minutes", async () => {
    const d = "2001-01-14";
    await insert([1, 2, 10].map((m) => ev("LeadAccepted", { enquiryId: "e", matchId: `m${m}`, sellerBusinessId: "s", creditTxnId: null, responseMs: m * MIN }, at(d))));
    await computeDay(d, { only: ["median_lead_response_minutes"] });
    expect(await val("median_lead_response_minutes", d)).toEqual({ value: 2, num: null, den: 3 });
  });

  it("enquiry_review_hold_rate uses the latest score per enquiry", async () => {
    const d = "2001-01-15";
    await insert([
      ev("EnquiryScored", { enquiryId: "e1", intentScore: 0.9, needsReview: false }, at(d)),
      ev("EnquiryScored", { enquiryId: "e2", intentScore: 0.2, needsReview: true }, at(d)),
      ev("EnquiryScored", { enquiryId: "e3", intentScore: 0.5, needsReview: false }, at(d, "10:00")),
      ev("EnquiryScored", { enquiryId: "e3", intentScore: 0.4, needsReview: true }, at(d, "11:00")), // rescored: now held
      ev("EnquiryScored", { enquiryId: "e4", intentScore: 0.5, needsReview: true }, at(d, "10:00")),
      ev("EnquiryScored", { enquiryId: "e4", intentScore: 0.9, needsReview: false }, at(d, "11:00")), // released
    ]);
    await computeDay(d, { only: ["enquiry_review_hold_rate"] });
    expect(await val("enquiry_review_hold_rate", d)).toEqual({ value: 0.5, num: 2, den: 4 });
  });
});

describe("trust and onboarding metrics", () => {
  it("t1_plus_seller_share: cumulative snapshot, sellers only, tier >= 1", async () => {
    const d = "2001-01-16";
    await insert([
      ...["b1", "b2", "b3", "b4"].map((b) => ev("BusinessCreated", { businessId: b, personId: "p", isSeller: true }, at(d, "09:00", -3 * DAY))),
      ev("BusinessCreated", { businessId: "b5", personId: "p", isSeller: false }, at(d)),
      ev("BusinessVerified", { businessId: "b1", tier: 1, kind: "gstin" }, at(d)),
      ev("BusinessVerified", { businessId: "b2", tier: 1, kind: "gstin" }, at(d)),
      ev("BusinessVerified", { businessId: "b2", tier: 2, kind: "doc" }, at(d, "11:00")), // upgrade counted once
      ev("BusinessVerified", { businessId: "b3", tier: 0, kind: "phone" }, at(d)),
      ev("BusinessVerified", { businessId: "b5", tier: 1, kind: "gstin" }, at(d)), // buyer, not a seller
      ev("BusinessVerified", { businessId: "b4", tier: 1, kind: "gstin" }, at(d, "10:00", DAY)), // next day
    ]);
    await computeDay(d, { only: ["t1_plus_seller_share"] });
    await computeDay("2001-01-17", { only: ["t1_plus_seller_share"] });
    expect(await val("t1_plus_seller_share", d)).toEqual({ value: 0.5, num: 2, den: 4 });
    expect(await val("t1_plus_seller_share", "2001-01-17")).toEqual({ value: 0.75, num: 3, den: 4 });
  });

  it("false_badge_proxy: revocation within 90 days of verification", async () => {
    const d = "2001-01-18";
    await insert([
      ...["b1", "b2", "b3", "b4"].map((b) => ev("BusinessVerified", { businessId: b, tier: 1, kind: "gstin" }, at(d))),
      ev("BusinessVerified", { businessId: "b0", tier: 0, kind: "phone" }, at(d)),
      ev("TrustScoreChanged", { businessId: "b1", from: 50, to: 10, badgeActive: false }, at(d, "10:00", 30 * DAY)),
      ev("TrustScoreChanged", { businessId: "b2", from: 50, to: 10, badgeActive: false }, at(d, "10:00", 100 * DAY)), // too late
      ev("TrustScoreChanged", { businessId: "b3", from: 10, to: 50, badgeActive: true }, at(d, "10:00", 10 * DAY)),
      ev("TrustScoreChanged", { businessId: "b0", from: 50, to: 10, badgeActive: false }, at(d, "10:00", 10 * DAY)), // tier 0: not in cohort
    ]);
    await computeDay(d, { only: ["false_badge_proxy"] });
    expect(await val("false_badge_proxy", d)).toEqual({ value: 0.25, num: 1, den: 4 });
  });

  it("time_to_first_listing_median_minutes and onboarding_completion_rate", async () => {
    const d = "2001-01-19";
    await insert([
      ...["s1", "s2", "s3", "s4"].map((b) => ev("BusinessCreated", { businessId: b, personId: "p", isSeller: true }, at(d))),
      ev("BusinessCreated", { businessId: "buyer", personId: "p", isSeller: false }, at(d)),
      ev("ListingVersionPublished", { listingId: "l1", versionId: "v", version: 1, sellerBusinessId: "s1", previousVersionId: null }, at(d, "10:00", 10 * MIN)),
      ev("ListingPublished", { listingId: "l2", sellerBusinessId: "s2", categoryId: "c" }, at(d, "10:00", 20 * MIN)),
      ev("ListingPublished", { listingId: "l3", sellerBusinessId: "s3", categoryId: "c" }, at(d, "10:00", 8 * DAY)), // in 30d, not in 7d
      ev("ListingPublished", { listingId: "l4", sellerBusinessId: "buyer", categoryId: "c" }, at(d, "10:00", 5 * MIN)),
    ]);
    await computeDay(d, { only: ["time_to_first_listing_median_minutes", "onboarding_completion_rate"] });
    expect(await val("onboarding_completion_rate", d)).toEqual({ value: 0.5, num: 2, den: 4 });
    // hits: 10, 20 and 8 days; median = 20
    expect(await val("time_to_first_listing_median_minutes", d)).toEqual({ value: 20, num: null, den: 3 });
  });
});

describe("moderation, UGC, leadgen and volume counters", () => {
  it("listing reject rate and ugc approval rate", async () => {
    const d = "2001-01-20";
    await insert([
      ev("ListingModerated", { listingId: "l1", sellerBusinessId: "s", status: "approved" }, at(d)),
      ev("ListingModerated", { listingId: "l2", sellerBusinessId: "s", status: "rejected" }, at(d)),
      ev("ListingModerated", { listingId: "l3", sellerBusinessId: "s", status: "review" }, at(d)),
      ev("ListingVersionReviewed", { listingId: "l4", versionId: "v", version: 1, sellerBusinessId: "s", status: "rejected", reviewedBy: null }, at(d)),
      ev("ReviewModerated", { reviewId: "r1", listingId: "l", sellerBusinessId: "s", status: "approved", rating: 5, moderatedBy: "x" }, at(d)),
      ev("ReviewModerated", { reviewId: "r2", listingId: "l", sellerBusinessId: "s", status: "rejected", rating: 1, moderatedBy: "x" }, at(d)),
      ev("CommentModerated", { commentId: "c1", listingId: "l", status: "approved", moderatedBy: "x" }, at(d)),
    ]);
    await computeDay(d, { only: ["listing_moderation_reject_rate", "ugc_approval_rate"] });
    expect(await val("listing_moderation_reject_rate", d)).toEqual({ value: 0.5, num: 2, den: 4 });
    expect(await val("ugc_approval_rate", d)).toMatchObject({ num: 2, den: 3 });
  });

  it("leadgen_verified_to_enquiry_rate", async () => {
    const d = "2001-01-21";
    await insert([
      ...["c1", "c2", "c3", "c4"].map((c) => ev("LeadCaptureVerified", { captureId: c, personId: "p", trigger: "t", unlock: "u", listingId: null, isNewPerson: true }, at(d))),
      ev("LeadCaptureConverted", { captureId: "c1", personId: "p", trigger: "t", enquiryId: "e" }, at(d, "10:00", HOUR)),
      ev("LeadCaptureConverted", { captureId: "c2", personId: "p", trigger: "t", enquiryId: "e" }, at(d, "10:00", 2 * DAY)),
      ev("LeadCaptureConverted", { captureId: "c3", personId: "p", trigger: "t", enquiryId: "e" }, at(d, "10:00", 9 * DAY)),
    ]);
    await computeDay(d, { only: ["leadgen_verified_to_enquiry_rate"] });
    expect(await val("leadgen_verified_to_enquiry_rate", d)).toEqual({ value: 0.5, num: 2, den: 4 });
  });

  it("count metrics; empty day has zeros for counts and no rows for rates", async () => {
    const d = "2001-01-22";
    await insert([
      ev("OrderRecorded", { orderId: "o1", matchId: "m", enquiryId: "e", buyerBusinessId: "b", sellerBusinessId: "s", totalPaise: 1 }, at(d)),
      ev("OrderRecorded", { orderId: "o2", matchId: "m", enquiryId: "e", buyerBusinessId: "b", sellerBusinessId: "s", totalPaise: null }, at(d)),
      ev("SubscriptionStarted", { businessId: "b", subscriptionId: "s", planCode: "pro" }, at(d)),
      ev("SubscriptionCancelled", { businessId: "b", subscriptionId: "s", planCode: "pro", billingInterval: "monthly", refundPaise: 0, unusedMonths: 0, effectiveAt: at(d).toISOString(), reason: null }, at(d)),
      ev("CreditConsumed", { businessId: "b", txnId: "t", refType: "match", refId: "m" }, at(d)),
      ev("CreditConsumed", { businessId: "b", txnId: "t2", refType: "match", refId: "m2" }, at(d)),
      ev("CreditRefunded", { businessId: "b", txnId: "t", refType: "match", refId: "m" }, at(d)),
      ev("OrderRecorded", { orderId: "o3", matchId: "m", enquiryId: "e", buyerBusinessId: "b", sellerBusinessId: "s", totalPaise: 1 }, at(d, "23:59", 2 * MIN)), // next IST day
    ]);
    await computeDay(d);
    expect((await val("orders_recorded", d))?.value).toBe(2);
    expect((await val("subscription_starts", d))?.value).toBe(1);
    expect((await val("subscription_cancels", d))?.value).toBe(1);
    expect((await val("credits_consumed", d))?.value).toBe(2);
    expect((await val("credits_refunded", d))?.value).toBe(1);

    const empty = "2001-01-25";
    const res = await computeDay(empty);
    expect(await val("lead_to_conversation_rate", empty)).toBeNull();
    expect(await val("median_lead_response_minutes", empty)).toBeNull();
    expect(await val("time_to_first_listing_median_minutes", empty)).toBeNull();
    expect(await val("t1_plus_seller_share", empty)).toBeNull();
    expect((await val("orders_recorded", empty))?.value).toBe(0);
    const rows = await prisma.metricDaily.findMany({ where: { day: new Date(`${empty}T00:00:00Z`) } });
    expect(rows.every((r) => Number.isFinite(r.value))).toBe(true);
    expect(rows.length).toBe(res.rows);
    expect(res.alerts).toBe(0);
  });
});

describe("recompute, backfill and reads", () => {
  it("is idempotent and picks up late events", async () => {
    const d = "2001-02-01";
    await insert([
      ...many(4, (i) => ev("LeadAccepted", { enquiryId: "e", matchId: `m${i}`, sellerBusinessId: "s", creditTxnId: null, responseMs: MIN }, at(d))),
      ev("LeadRefunded", { enquiryId: "e", matchId: "m0", sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "11:00")),
    ]);
    const a = await computeDay(d);
    const snap1 = await prisma.metricDaily.findMany({ where: { day: new Date(`${d}T00:00:00Z`) }, orderBy: [{ metric: "asc" }, { dimension: "asc" }] });
    const b = await computeDay(d);
    const snap2 = await prisma.metricDaily.findMany({ where: { day: new Date(`${d}T00:00:00Z`) }, orderBy: [{ metric: "asc" }, { dimension: "asc" }] });
    expect(b.rows).toBe(a.rows);
    expect(snap2.map((r) => [r.metric, r.dimension, r.value, r.numerator, r.denominator])).toEqual(snap1.map((r) => [r.metric, r.dimension, r.value, r.numerator, r.denominator]));
    expect((await val("auto_refund_rate", d))?.value).toBe(0.25);

    // a late-arriving refund (occurred_at on the day, inserted afterwards) lands on recompute
    await insert([ev("LeadRefunded", { enquiryId: "e", matchId: "m1", sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "22:00"))]);
    await computeDay(d);
    expect((await val("auto_refund_rate", d))?.value).toBe(0.5);
  });

  it("removes stale rows when the underlying events disappear", async () => {
    const d = "2001-02-02";
    await insert([ev("LeadAccepted", { enquiryId: "e", matchId: "m", sellerBusinessId: "s", creditTxnId: null, responseMs: MIN }, at(d))]);
    await computeDay(d, { only: ["auto_refund_rate"] });
    expect(await val("auto_refund_rate", d)).not.toBeNull();
    await prisma.domainEvent.deleteMany({ where: { aggregateType: "MetricsTest" } });
    await computeDay(d, { only: ["auto_refund_rate"] });
    expect(await val("auto_refund_rate", d)).toBeNull();
  });

  it("backfill covers a range; series, scorecard read it back", async () => {
    await insert([
      ...["2001-03-01", "2001-03-02", "2001-03-04"].flatMap((d, i) =>
        many(3, (k) => ev("LeadAccepted", { enquiryId: "e", matchId: `m${i}-${k}`, sellerBusinessId: "s", creditTxnId: null, responseMs: (i + 1) * 10 * MIN }, at(d))),
      ),
      ev("LeadRefunded", { enquiryId: "e", matchId: "m0-0", sellerBusinessId: "s", reason: "buyer_fake" }, at("2001-03-01", "12:00")),
    ]);
    const res = await backfill("2001-03-01", "2001-03-04", { only: ["auto_refund_rate", "median_lead_response_minutes"] });
    expect(res.map((r) => r.day)).toEqual(["2001-03-01", "2001-03-02", "2001-03-03", "2001-03-04"]);
    const series = await getMetricSeries("median_lead_response_minutes", { from: "2001-03-01", to: "2001-03-04" });
    expect(series.map((s) => [s.day, s.value])).toEqual([["2001-03-01", 10], ["2001-03-02", 20], ["2001-03-04", 30]]);
    await expect(getMetricSeries("nope", { from: "2001-03-01", to: "2001-03-04" })).rejects.toMatchObject({ code: "validation" });

    const card = await getScorecard("2001-03-04", NOW);
    const refund = card.find((c) => c.id === "auto_refund_rate")!;
    expect(refund.latest).toMatchObject({ day: "2001-03-04", value: 0 });
    expect(refund.status).toBe("met");
    expect(refund.avg7).toBeCloseTo(1 / 9);
    expect(refund.avg28).toBeCloseTo(1 / 9);
    expect(refund.series).toHaveLength(3);
    const conv = card.find((c) => c.id === "lead_to_conversation_rate")!;
    expect(conv).toMatchObject({ status: "no_data", latest: null, avg7: null });
    expect(card.find((c) => c.id === "median_lead_response_minutes")).toMatchObject({ status: "info" });
    // immature days are excluded from "latest"
    const early = await getScorecard("2001-03-04", new Date("2001-03-05T00:00:00Z"));
    expect(early.find((c) => c.id === "auto_refund_rate")!.latest).toBeNull();
    expect(early.find((c) => c.id === "median_lead_response_minutes")!.latest).toMatchObject({ day: "2001-03-04" });
  });

  it("rejects unknown metrics and malformed days", async () => {
    await expect(computeDay("2001-13-40")).rejects.toMatchObject({ code: "validation" });
    await expect(computeDay("2001-01-01", { only: ["nope"] })).rejects.toMatchObject({ code: "validation" });
    await expect(getDimensionBreakdown("nope", { from: "2001-01-01", to: "2001-01-02" })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("alerts", () => {
  const accepted = (d: string, n: number, extra: Record<string, unknown> = {}) =>
    many(n, (i) => ev("LeadAccepted", { enquiryId: "e", matchId: `${d}-m${i}`, sellerBusinessId: "s", creditTxnId: null, responseMs: MIN, ...extra }, at(d)));
  const refunds = (d: string, n: number) =>
    many(n, (i) => ev("LeadRefunded", { enquiryId: "e", matchId: `${d}-m${i}`, sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "12:00")));

  it("'above' threshold: refund rate > 10% raises, at/under does not, small samples are ignored", async () => {
    await insert([...accepted("2001-04-01", 20), ...refunds("2001-04-01", 3)]); // 15%
    await insert([...accepted("2001-04-02", 20), ...refunds("2001-04-02", 2)]); // exactly 10%: not above
    await insert([...accepted("2001-04-03", 5), ...refunds("2001-04-03", 5)]); // 100% but sample 5
    const r1 = await computeDay("2001-04-01", { only: ["auto_refund_rate"], now: NOW });
    await computeDay("2001-04-02", { only: ["auto_refund_rate"], now: NOW });
    await computeDay("2001-04-03", { only: ["auto_refund_rate"], now: NOW });
    expect(r1.alerts).toBe(1);
    const open = await listAlerts({ open: true });
    const mine = open.filter((a) => a.day.startsWith("2001-04"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ metric: "auto_refund_rate", day: "2001-04-01", direction: "above", threshold: 0.1, title: "Auto-refund rate" });
    expect(mine[0]!.message).toContain("15.0%");
  });

  it("'below' threshold: lead to conversation < 60% raises; healthy day does not", async () => {
    const matched = (d: string, n: number) => many(n, (i) => ev("LeadMatched", { enquiryId: "e", matchId: `${d}-m${i}` }, at(d)));
    const conv = (d: string, n: number) => many(n, (i) => ev("ConversationStarted", { conversationId: `c${i}`, matchId: `${d}-m${i}` }, at(d, "11:00")));
    await insert([...matched("2001-04-05", 20), ...conv("2001-04-05", 5), ...matched("2001-04-06", 20), ...conv("2001-04-06", 15)]);
    await computeDay("2001-04-05", { only: ["lead_to_conversation_rate"], now: NOW });
    await computeDay("2001-04-06", { only: ["lead_to_conversation_rate"], now: NOW });
    const a = (await listAlerts({ open: true })).filter((x) => x.day.startsWith("2001-04"));
    expect(a.map((x) => [x.metric, x.day, x.direction])).toEqual([["lead_to_conversation_rate", "2001-04-05", "below"]]);
  });

  it("median response above 120 minutes raises", async () => {
    await insert(many(6, (i) => ev("LeadAccepted", { enquiryId: "e", matchId: `m${i}`, sellerBusinessId: "s", creditTxnId: null, responseMs: 3 * HOUR }, at("2001-04-07"))));
    await computeDay("2001-04-07", { only: ["median_lead_response_minutes"] }); // windowDays 0, real now is far later
    const a = (await listAlerts({ open: true })).find((x) => x.day === "2001-04-07");
    expect(a).toMatchObject({ metric: "median_lead_response_minutes", value: 180, threshold: 120 });
  });

  it("does not alert on immature days", async () => {
    await insert([...accepted("2001-04-08", 20), ...refunds("2001-04-08", 10)]);
    const res = await computeDay("2001-04-08", { only: ["auto_refund_rate"], now: new Date("2001-04-09T00:00:00Z") });
    expect(res.alerts).toBe(0);
  });

  it("refreshes an open alert on recompute, resolve is idempotent and resolved alerts stay resolved", async () => {
    const d = "2001-04-09";
    await insert([...accepted(d, 20), ...refunds(d, 3)]);
    await computeDay(d, { only: ["auto_refund_rate"], now: NOW });
    await insert(refunds(d, 0));
    await insert([ev("LeadRefunded", { enquiryId: "e", matchId: `${d}-m10`, sellerBusinessId: "s", reason: "buyer_fake" }, at(d, "13:00"))]);
    await computeDay(d, { only: ["auto_refund_rate"], now: NOW });
    const [alert] = (await listAlerts({ open: true })).filter((x) => x.day === d);
    expect(alert!.value).toBeCloseTo(4 / 20);
    expect(await countOpenAlerts()).toBeGreaterThanOrEqual(1);

    const resolved = await resolveAlert(alert!.id, "staff-1");
    expect(resolved.resolvedAt).not.toBeNull();
    const again = await resolveAlert(alert!.id, "staff-2");
    expect(again.resolvedAt).toBe(resolved.resolvedAt);
    expect((await listAlerts({ open: true })).some((x) => x.id === alert!.id)).toBe(false);
    expect((await listAlerts({ open: false })).some((x) => x.id === alert!.id)).toBe(true);
    expect((await listAlerts({})).some((x) => x.id === alert!.id)).toBe(true);

    const res = await computeDay(d, { only: ["auto_refund_rate"], now: NOW });
    expect(res.alerts).toBe(0);
    expect((await listAlerts({ open: true })).some((x) => x.id === alert!.id)).toBe(false);
    await expect(resolveAlert("00000000-0000-0000-0000-000000000000", "s")).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveAlert("not-a-uuid", "s")).rejects.toMatchObject({ code: "not_found" });
  });
});
