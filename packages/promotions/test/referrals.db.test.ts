import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { getBalance } from "@cnote/billing";
import { applyReferralCode, decodeReferralCode, listReferralsFor, listReferralsForReview, qualifyOnVerification, qualifyReferral, referralCodeFor, referralSummary, rejectReferral, releaseDueReferrals, releaseReferral, worker } from "../src/index";
import { cleanup, DAY, mkBusiness, mkListing, shareMember, uid } from "./helpers";

afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { aggregateType: "referral" } });
  await cleanup();
});
const phone = () => `+91${Math.floor(6_000_000_000 + Math.random() * 3_999_999_999)}`;
const pair = async (opts: { refereeTier?: number } = {}) => {
  const referrer = await mkBusiness(1, { phone: phone() });
  const referee = await mkBusiness(opts.refereeTier ?? 1, { phone: phone() });
  return { referrer, referee };
};

describe("codes", () => {
  it("round-trips a business id and rejects typos/garbage", () => {
    const id = uid();
    const code = referralCodeFor(id);
    expect(decodeReferralCode(code)).toBe(id);
    expect(decodeReferralCode(code.toLowerCase())).toBe(id);
    expect(decodeReferralCode(code.slice(0, -1) + (code.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(decodeReferralCode("nonsense")).toBeNull();
    expect(decodeReferralCode("")).toBeNull();
  });
});

describe("attach and anti-abuse", () => {
  it("attaches once per referee; rejects self-referral, shared persons and bad codes", async () => {
    const { referrer, referee } = await pair();
    const code = referralCodeFor(referrer.id);
    const r = await applyReferralCode({ refereeBusinessId: referee.id, code });
    expect(r).toMatchObject({ status: "pending", referrerBusinessId: referrer.id, riskFlags: [] });
    await expect(applyReferralCode({ refereeBusinessId: referee.id, code: referralCodeFor((await pair()).referrer.id) })).rejects.toMatchObject({ code: "conflict" });
    await expect(applyReferralCode({ refereeBusinessId: referrer.id, code })).rejects.toMatchObject({ message: expect.stringMatching(/own referral code/) });
    const sameOwner = await mkBusiness(1);
    await shareMember(referrer.personId!, sameOwner.id); // same person runs both businesses
    await expect(applyReferralCode({ refereeBusinessId: sameOwner.id, code })).rejects.toMatchObject({ message: expect.stringMatching(/your own account/) });
    await expect(applyReferralCode({ refereeBusinessId: (await mkBusiness(1)).id, code: "bogus" })).rejects.toMatchObject({ code: "validation" });
    await expect(applyReferralCode({ refereeBusinessId: (await mkBusiness(1)).id, code: referralCodeFor(uid()) })).rejects.toMatchObject({ code: "validation" }); // unknown business
  });

  it("flags shared phone numbers and referral rings for staff review", async () => {
    const a = await mkBusiness(1, { phone: phone() });
    const b = await mkBusiness(1, { phone: phone() });
    // ring: B referred A first, now A applies B's code
    await applyReferralCode({ refereeBusinessId: a.id, code: referralCodeFor(b.id) });
    const ring = await applyReferralCode({ refereeBusinessId: b.id, code: referralCodeFor(a.id) });
    expect(ring.riskFlags).toContain("referral_ring");
    const withExtra = await applyReferralCode({ refereeBusinessId: (await mkBusiness(1)).id, code: referralCodeFor(b.id), extraFlags: ["shared_ip"] });
    expect(withExtra.riskFlags).toEqual(["shared_ip"]);
  });
});

describe("qualification, hold and reward", () => {
  it("signup alone earns nothing: needs tier >= 1", async () => {
    const { referrer, referee } = await pair({ refereeTier: 0 });
    await applyReferralCode({ refereeBusinessId: referee.id, code: referralCodeFor(referrer.id) });
    expect(await qualifyReferral(referee.id, "listing_published")).toBeNull();
    expect((await prisma.referral.findUnique({ where: { refereeBusinessId: referee.id } }))!.status).toBe("pending");
    expect(await qualifyReferral(uid(), "listing_published")).toBeNull(); // no referral at all
  });

  it("qualify -> 7-day hold -> reward to BOTH sides via grantCredits, exactly once", async () => {
    const { referrer, referee } = await pair();
    const r = await applyReferralCode({ refereeBusinessId: referee.id, code: referralCodeFor(referrer.id) });
    const now = new Date();
    const q = (await qualifyReferral(referee.id, "listing_published", now))!;
    expect(q).toMatchObject({ status: "qualified", qualifyingAction: "listing_published" });
    expect(new Date(q.holdUntil!).getTime() - now.getTime()).toBe(7 * DAY);
    expect(await qualifyReferral(referee.id, "listing_published")).toBeNull(); // idempotent
    expect(await releaseDueReferrals(new Date(now.getTime() + 6 * DAY))).toBe(0); // still on hold
    await expect(releaseReferral(r.id, {}, new Date(now.getTime() + 6 * DAY))).rejects.toMatchObject({ code: "conflict" });
    const b0 = [await getBalance(referrer.id), await getBalance(referee.id)];
    expect(await releaseDueReferrals(new Date(now.getTime() + 8 * DAY))).toBeGreaterThanOrEqual(1);
    expect(await releaseDueReferrals(new Date(now.getTime() + 9 * DAY))).toBe(0);
    expect([await getBalance(referrer.id) - b0[0]!, await getBalance(referee.id) - b0[1]!]).toEqual([10, 10]);
    expect(await prisma.referral.findUnique({ where: { id: r.id } })).toMatchObject({ status: "rewarded", rewardCredits: 10 });
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: r.id } })).map((e) => e.type)).toEqual(["ReferralQualified", "ReferralRewarded"]);
    expect((await listReferralsFor(referrer.id))[0]).toMatchObject({ status: "rewarded" });
    expect(await referralSummary(referrer.id)).toMatchObject({ rewarded: 1, creditsEarned: 10 });
    await expect(rejectReferral(r.id, "late")).rejects.toMatchObject({ code: "conflict" });
  });

  it("flagged referrals are never auto-released; staff release or reject with a visible reason", async () => {
    const { referrer, referee } = await pair();
    const r = await applyReferralCode({ refereeBusinessId: referee.id, code: referralCodeFor(referrer.id), extraFlags: ["shared_ip"] });
    const now = new Date();
    await qualifyReferral(referee.id, "first_verified_enquiry", now);
    await releaseDueReferrals(new Date(now.getTime() + 30 * DAY));
    expect((await prisma.referral.findUnique({ where: { id: r.id } }))!.status).toBe("qualified");
    expect((await listReferralsForReview()).some((x) => x.id === r.id)).toBe(true);
    await expect(rejectReferral(r.id, "  ")).rejects.toMatchObject({ code: "validation" });
    const rejected = await rejectReferral(r.id, "Same device as the referrer", uid());
    expect(rejected).toMatchObject({ status: "rejected", rejectedReason: "Same device as the referrer" });
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: r.id } })).map((e) => e.type)).toContain("ReferralRejected");

    const p2 = await pair();
    const r2 = await applyReferralCode({ refereeBusinessId: p2.referee.id, code: referralCodeFor(p2.referrer.id), extraFlags: ["shared_ip"] });
    await qualifyReferral(p2.referee.id, "listing_published", now);
    expect((await releaseReferral(r2.id, { force: true })).status).toBe("rewarded");
    await expect(releaseReferral(uid())).rejects.toMatchObject({ code: "not_found" });
  });

  it("quarterly cap: a referrer beyond the cap has further referrals rejected with a reason", async () => {
    const referrer = await mkBusiness(1, { phone: phone() });
    const referees: string[] = [];
    for (let i = 0; i < 10; i++) {
      const e = await mkBusiness(1, { phone: phone() });
      referees.push(e.id);
      await applyReferralCode({ refereeBusinessId: e.id, code: referralCodeFor(referrer.id) });
      expect((await qualifyReferral(e.id, "listing_published"))!.status).toBe("qualified");
    }
    const extra = await mkBusiness(1, { phone: phone() });
    await applyReferralCode({ refereeBusinessId: extra.id, code: referralCodeFor(referrer.id) });
    expect(await qualifyReferral(extra.id, "listing_published")).toMatchObject({ status: "rejected", rejectedReason: expect.stringMatching(/quarterly/) });
  });
});

describe("event handlers", () => {
  it("ListingPublished, EnquiryCreated and BusinessVerified qualify the referee (LeadAccepted is deliberately not used: no buyer id)", async () => {
    const ev = (type: string, payload: object) => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: uid(), occurredAt: new Date().toISOString(), payload }) as never;
    const a = await pair();
    await applyReferralCode({ refereeBusinessId: a.referee.id, code: referralCodeFor(a.referrer.id) });
    await worker.handlers.ListingPublished!(ev("ListingPublished", { listingId: uid(), sellerBusinessId: a.referee.id, categoryId: uid() }));
    expect((await prisma.referral.findUnique({ where: { refereeBusinessId: a.referee.id } }))!.qualifyingAction).toBe("listing_published");

    const b = await pair();
    await applyReferralCode({ refereeBusinessId: b.referee.id, code: referralCodeFor(b.referrer.id) });
    await worker.handlers.EnquiryCreated!(ev("EnquiryCreated", { enquiryId: uid(), buyerBusinessId: b.referee.id, categoryId: null }));
    expect((await prisma.referral.findUnique({ where: { refereeBusinessId: b.referee.id } }))!.qualifyingAction).toBe("first_verified_enquiry");

    const c = await pair();
    await applyReferralCode({ refereeBusinessId: c.referee.id, code: referralCodeFor(c.referrer.id) });
    await worker.handlers.BusinessVerified!(ev("BusinessVerified", { businessId: c.referee.id, tier: 1, kind: "gstin" }));
    expect((await prisma.referral.findUnique({ where: { refereeBusinessId: c.referee.id } }))!.status).toBe("pending"); // verified but nothing published yet
    expect(await qualifyOnVerification(uid())).toBeNull();
    await worker.handlers.BusinessVerified!(ev("BusinessVerified", { businessId: c.referee.id, tier: 0, kind: "gstin_revoked" }));
    expect(await mkListing(c.referee.id)).toBeTruthy();
  });
});
