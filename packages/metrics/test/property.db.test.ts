import { prisma } from "@cnote/db";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeDay } from "../src";
import { METRICS } from "../src/definitions";
import { HOUR, MIN, at, cleanup as clean, ev, insert as ins } from "./helpers";

const NS = "MetricsTestProp";
const cleanup = () => clean(NS, "2001-05-01", "2001-05-31");
const insert = (e: Parameters<typeof ins>[0]) => ins(e, NS);

beforeAll(() => cleanup());
afterAll(() => cleanup());

// Random event soups on one test day: whatever the mix (duplicates, orphans, out-of-order), every
// rate metric stays inside [0,1] and every stored value is finite.
const DAY0 = "2001-05-01";
const ids = fc.constantFrom("a", "b", "c", "d");
const when = fc.integer({ min: 0, max: 20 * 24 * 60 }).map((m) => at(DAY0, "00:00", m * MIN));
const evArb = fc.oneof(
  fc.record({ t: fc.constant("LeadMatched"), id: ids, at: when }).map((x) => ev("LeadMatched", { matchId: x.id, enquiryId: x.id }, x.at)),
  fc.record({ id: ids, at: when }).map((x) => ev("ConversationStarted", { conversationId: x.id, matchId: x.id }, x.at)),
  fc.record({ id: ids, at: when, w: fc.boolean() }).map((x) => ev("DealReportedOffPlatform", { matchId: x.id, reportedByBusinessId: "s", outcome: x.w ? "won" : "lost" }, x.at)),
  fc.record({ id: ids, at: when }).map((x) => ev("LeadAccepted", { matchId: x.id, enquiryId: x.id, sellerBusinessId: "s", creditTxnId: null, responseMs: HOUR }, x.at)),
  fc.record({ id: ids, at: when }).map((x) => ev("LeadRefunded", { matchId: x.id, enquiryId: x.id, sellerBusinessId: "s", reason: "buyer_fake" }, x.at)),
  fc.record({ id: ids, at: when, n: fc.boolean() }).map((x) => ev("EnquiryScored", { enquiryId: x.id, intentScore: 0.5, needsReview: x.n }, x.at)),
  fc.record({ id: ids, at: when, s: fc.boolean() }).map((x) => ev("BusinessCreated", { businessId: x.id, personId: "p", isSeller: x.s }, x.at)),
  fc.record({ id: ids, at: when, tier: fc.integer({ min: 0, max: 3 }) }).map((x) => ev("BusinessVerified", { businessId: x.id, tier: x.tier, kind: "k" }, x.at)),
  fc.record({ id: ids, at: when, b: fc.boolean() }).map((x) => ev("TrustScoreChanged", { businessId: x.id, from: 1, to: 2, badgeActive: x.b }, x.at)),
  fc.record({ id: ids, at: when }).map((x) => ev("ListingPublished", { listingId: x.id, sellerBusinessId: x.id, categoryId: "c" }, x.at)),
  fc.record({ id: ids, at: when, s: fc.constantFrom("approved", "rejected") }).map((x) => ev("ReviewModerated", { reviewId: x.id, status: x.s }, x.at)),
);

describe("rate metrics are always within [0,1] (property, DB-backed)", () => {
  it("holds for arbitrary event mixes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(evArb, { minLength: 0, maxLength: 40 }), async (events) => {
        await cleanup();
        await insert(events);
        await computeDay(DAY0, { now: new Date("2002-01-01T00:00:00Z") });
        const rows = await prisma.metricDaily.findMany({ where: { day: new Date(`${DAY0}T00:00:00Z`) } });
        const rates = new Set(METRICS.filter((m) => m.kind === "rate").map((m) => m.id));
        for (const r of rows) {
          expect(Number.isFinite(r.value)).toBe(true);
          if (rates.has(r.metric)) {
            expect(r.value).toBeGreaterThanOrEqual(0);
            expect(r.value).toBeLessThanOrEqual(1);
            expect(r.numerator!).toBeLessThanOrEqual(r.denominator!);
          }
        }
      }),
      { numRuns: 12 },
    );
  }, 60_000);
});
