import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listings: new Map<string, { id: string; sellerBusinessId: string; status: string }>(),
  /** person id -> facts; anything not listed is an unknown/new account */
  people: new Map<string, { emailVerified: boolean; phoneVerified: boolean; erased: boolean; createdAt: string }>(),
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: randomUUID(), confidence: 1, needsReview: false, deterministic: "clean" }),
}));
vi.mock("@cnote/catalogue", () => ({
  getListing: async (id: string) => state.listings.get(id) ?? null,
  listSellerListings: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async () => new Map(),
  getPersonVerification: async (id: string) => state.people.get(id) ?? null,
}));
vi.mock("@cnote/enquiry", () => ({}));

import { moderate, react, submitReview } from "../src";

const staffId = randomUUID();
const sellerBiz = randomUUID();
const listingIds: string[] = [];
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const credible = () => { const id = randomUUID(); state.people.set(id, { emailVerified: true, phoneVerified: false, erased: false, createdAt: days(60) }); return { personId: id, businessId: null }; };
const freshVerified = () => { const id = randomUUID(); state.people.set(id, { emailVerified: true, phoneVerified: true, erased: false, createdAt: days(0) }); return { personId: id, businessId: null }; };
const unverifiedOld = () => { const id = randomUUID(); state.people.set(id, { emailVerified: false, phoneVerified: false, erased: false, createdAt: days(90) }); return { personId: id, businessId: null }; };
const unknown = () => ({ personId: randomUUID(), businessId: null });

async function approvedReview() {
  const l = randomUUID();
  state.listings.set(l, { id: l, sellerBusinessId: sellerBiz, status: "published" });
  listingIds.push(l);
  const author = { personId: randomUUID(), businessId: null };
  const r = await submitReview(author, l, { rating: 4, title: "Solid", body: "Works well for our factory floor, delivery was on time." });
  await moderate("review", r.id, "approved", null, staffId);
  return r.id;
}
const report = (a: { personId: string; businessId: null }, id: string, ip?: string) => react(a, { subjectType: "review", subjectId: id, kind: "report", reason: "Looks fake", ip });
const row = (id: string) => prisma.productReview.findUniqueOrThrow({ where: { id } });
const queued = (id: string) => prisma.reviewItem.count({ where: { subjectType: "message", subjectId: id } });

beforeEach(() => {
  delete process.env.REVIEWS_REPORTS_PER_PERSON_HOUR;
  delete process.env.REVIEWS_REPORTS_PER_IP_HOUR;
});
afterAll(async () => {
  const revs = (await prisma.productReview.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((r) => r.id);
  await prisma.reviewItem.deleteMany({ where: { subjectId: { in: revs } } });
  await prisma.ugcReaction.deleteMany({ where: { subjectId: { in: revs } } });
  await prisma.productReview.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingRatingSummary.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${revs})`;
  await prisma.$disconnect();
});

describe("report brigading (security audit)", () => {
  it("three reports from brand-new, unverified or unknown accounts do NOT hide the review; staff are asked to look", async () => {
    const id = await approvedReview();
    for (const reporter of [unknown(), freshVerified(), unverifiedOld()]) await report(reporter, id);
    expect(await row(id)).toMatchObject({ status: "approved", reportCount: 3 });
    expect(await queued(id)).toBe(1);
  });

  it("three reports from distinct verified, aged accounts auto-hide it (as before)", async () => {
    const id = await approvedReview();
    for (const reporter of [credible(), credible(), credible()]) await report(reporter, id);
    expect(await row(id)).toMatchObject({ status: "flagged", reportCount: 3 });
    expect(await queued(id)).toBe(0);
  });

  it("credibility is counted per distinct account: a swarm of throw-aways plus two real reporters still needs a third real one", async () => {
    const id = await approvedReview();
    for (const reporter of [unknown(), unknown(), unknown(), credible(), credible()]) await report(reporter, id);
    expect((await row(id)).status).toBe("approved");
    await report(credible(), id);
    expect((await row(id)).status).toBe("flagged");
  });

  it("a person is rate limited on reports (per hour), and an IP is rate limited across people", async () => {
    process.env.REVIEWS_REPORTS_PER_PERSON_HOUR = "2";
    const spammer = credible();
    await report(spammer, await approvedReview());
    await report(spammer, await approvedReview());
    await expect(report(spammer, await approvedReview())).rejects.toMatchObject({ code: "rate_limited" });

    process.env.REVIEWS_REPORTS_PER_IP_HOUR = "2";
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    await report(credible(), await approvedReview(), ip);
    await report(credible(), await approvedReview(), ip);
    await expect(report(credible(), await approvedReview(), ip)).rejects.toMatchObject({ code: "rate_limited" });
  });
});
