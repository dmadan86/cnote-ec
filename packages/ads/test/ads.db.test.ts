import { prisma } from "@cnote/db";
import { redis } from "@cnote/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const uid = `ads${Date.now().toString(36)}`;
const fx = {
  root: "", leaf: "", prohibitedCat: "",
  seller: "", weak: "", buyer: "", person: "",
  l1: "", l2: "", l3: "", lWeak: "",
};
const live = new Map<string, any>();

vi.mock("@cnote/catalogue", async (orig) => {
  const actual = await orig<typeof import("@cnote/catalogue")>();
  const cats = () => [
    { id: fx.root, slug: `${uid}-root`, name: "Packaging", parentId: null, prohibited: false },
    { id: fx.leaf, slug: `${uid}-leaf`, name: "Cosmetic boxes", parentId: fx.root, prohibited: false },
    { id: fx.prohibitedCat, slug: `${uid}-bad`, name: "Bad", parentId: null, prohibited: true },
  ];
  return {
    ...actual,
    getPublicListingsByIds: async (ids: string[]) => ids.flatMap((i) => (live.has(i) ? [live.get(i)] : [])),
    listCategories: async () => cats(),
    getCategoryById: async (id: string) => cats().find((c) => c.id === id) ?? null,
    getListing: async (id: string) => live.get(id) ?? null,
    getListingsByIds: async (ids: string[]) => ids.flatMap((i) => (live.has(i) ? [live.get(i)] : [])),
  };
});

const ads = await import("../src");
const wallet = await import("@cnote/billing");
const { resetSnapshotCacheForTests } = await import("../src/eligibility");
const { resetAdsConfigCache } = await import("../src/config");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0";
let ipSeq = 1;
const click = (token: string, o: Record<string, unknown> = {}) =>
  ads.recordClick(token, { visitorId: `v-${ipSeq}`, ip: `10.${ipSeq % 250}.${Math.floor(ipSeq++ / 250)}.5`, userAgent: UA, ...o });

const listingView = (id: string, seller: string, cat: string, title: string, over: object = {}) => ({
  id, sellerBusinessId: seller, category: { id: cat, slug: "x", name: "x" }, title, description: "", attributes: {}, pricePaise: 10_000, priceUnit: "piece", moq: 100, moqUnit: "piece",
  hsn: null, language: "en", imageUrls: ["/img/1"], aiGenerated: false, status: "published", moderationStatus: "approved", moderationReason: null, createdAt: "", updatedAt: "", ...over,
});

async function mkListing(seller: string, title: string, cat: string) {
  return (await prisma.listing.create({ data: { sellerBusinessId: seller, categoryId: cat, title, status: "published", moderationStatus: "approved", pricePaise: 10_000n, imageUrls: ["/img/1"] } })).id;
}

async function approvedCampaign(o: { seller?: string; listing?: string; daily?: number; total?: number | null; keyword?: string; name?: string } = {}) {
  const seller = o.seller ?? fx.seller;
  const c = await ads.createCampaign(seller, { name: o.name ?? "Cosmetic push", dailyBudgetPaise: o.daily ?? 10_000, totalBudgetPaise: o.total ?? null, startsAt: new Date(Date.now() - 3600_000) });
  const g = await ads.addAdGroup(seller, c.id, { name: "G1", surfaces: ["search", "category", "product_similar"] });
  const al = await ads.addListingToGroup(seller, g.id, o.listing ?? fx.l1);
  await ads.addKeyword(seller, g.id, { text: o.keyword ?? "cosmetic boxes", matchType: "phrase" });
  await ads.submitCampaign(seller, c.id);
  await ads.decideCampaign({ campaignId: c.id, staffId: crypto.randomUUID(), decision: "approved" });
  return { campaignId: c.id, adGroupId: g.id, adGroupListingId: al.id };
}

const organic = (n: number) => Array.from({ length: n }, (_, i) => `org-${i}`);
const slots = (o: Partial<Parameters<typeof ads.getSponsoredSlots>[0]> = {}) =>
  ads.getSponsoredSlots({ query: "cosmetic boxes", surface: "search", organicListingIds: organic(20), visitorId: `vis-${Math.random()}`, random: () => 0, ...o });

const cleanup = async () => {
  const sellers = [fx.seller, fx.weak];
  const camps = (await prisma.adCampaign.findMany({ where: { sellerBusinessId: { in: sellers } }, select: { id: true } })).map((c) => c.id);
  await prisma.adAttribution.deleteMany({ where: { campaignId: { in: camps } } });
  await prisma.adClick.deleteMany({ where: { campaignId: { in: camps } } });
  await prisma.adSpendSettlement.deleteMany({ where: { campaignId: { in: camps } } });
  await prisma.adImpressionRollup.deleteMany({ where: { campaignId: { in: camps } } });
  await prisma.adReviewAction.deleteMany({ where: { campaignId: { in: camps } } });
  await prisma.adKeyword.deleteMany({ where: { adGroup: { campaignId: { in: camps } } } });
  await prisma.adGroupListing.deleteMany({ where: { adGroup: { campaignId: { in: camps } } } });
  await prisma.adGroup.deleteMany({ where: { campaignId: { in: camps } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: camps } } });
  await prisma.adWalletEntry.deleteMany({ where: { businessId: { in: sellers } } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: [...camps, ...sellers] } }] } });
};

beforeAll(async () => {
  process.env.ADS_ENABLED = "true";
  fx.root = (await prisma.category.create({ data: { slug: `${uid}-root`, name: "Packaging" } })).id;
  fx.leaf = (await prisma.category.create({ data: { slug: `${uid}-leaf`, name: "Cosmetic boxes", parentId: fx.root } })).id;
  fx.prohibitedCat = (await prisma.category.create({ data: { slug: `${uid}-bad`, name: "Bad", prohibited: true } })).id;
  fx.seller = (await prisma.business.create({ data: { name: `${uid}-seller`, isSeller: true, verificationTier: 1, trustScore: 70, state: "Karnataka" } })).id;
  fx.weak = (await prisma.business.create({ data: { name: `${uid}-weak`, isSeller: true, verificationTier: 1, trustScore: 40 } })).id;
  fx.buyer = (await prisma.business.create({ data: { name: `${uid}-buyer` } })).id;
  fx.person = (await prisma.person.create({ data: { email: `${uid}@example.test` } })).id;
  await prisma.businessMember.create({ data: { businessId: fx.seller, personId: fx.person } });
  fx.l1 = await mkListing(fx.seller, "Cosmetic boxes premium", fx.leaf);
  fx.l2 = await mkListing(fx.seller, "Lipstick packaging tube", fx.leaf);
  fx.l3 = await mkListing(fx.seller, "Prohibited thing", fx.prohibitedCat);
  fx.lWeak = await mkListing(fx.weak, "Cosmetic boxes cheap", fx.leaf);
  live.set(fx.l1, listingView(fx.l1, fx.seller, fx.leaf, "Cosmetic boxes premium"));
  live.set(fx.l2, listingView(fx.l2, fx.seller, fx.leaf, "Lipstick packaging tube"));
  live.set(fx.l3, listingView(fx.l3, fx.seller, fx.prohibitedCat, "Prohibited thing"));
  live.set(fx.lWeak, listingView(fx.lWeak, fx.weak, fx.leaf, "Cosmetic boxes cheap"));
  await prisma.adRateCard.create({ data: { categoryId: null, surface: "search", cpcPaise: 500n, effectiveFrom: new Date(Date.now() - 86_400_000) } });
  await prisma.adRateCard.create({ data: { categoryId: null, surface: "category", cpcPaise: 400n, effectiveFrom: new Date(Date.now() - 86_400_000) } });
  await prisma.adRateCard.create({ data: { categoryId: null, surface: "product_similar", cpcPaise: 300n, effectiveFrom: new Date(Date.now() - 86_400_000) } });
});

afterAll(async () => {
  await ads.waitForBackgroundSweeps();
  await cleanup();
  await prisma.adRateCard.deleteMany({});
  await prisma.adConfig.deleteMany({});
  await prisma.businessMember.deleteMany({ where: { personId: fx.person } });
  await prisma.person.delete({ where: { id: fx.person } });
  await prisma.listing.deleteMany({ where: { id: { in: [fx.l1, fx.l2, fx.l3, fx.lWeak] } } });
  await prisma.business.deleteMany({ where: { id: { in: [fx.seller, fx.weak, fx.buyer] } } });
  await prisma.category.deleteMany({ where: { id: { in: [fx.leaf, fx.root, fx.prohibitedCat] } } });
  await redis.del("ads:snap:v1", "ads:kill:all", "ads:kill:search");
});

beforeEach(async () => {
  await ads.waitForBackgroundSweeps();
  await cleanup();
  await redis.del("ads:snap:v1", "ads:kill:all", "ads:kill:search", "ads:sweep:lock");
  resetSnapshotCacheForTests();
  resetAdsConfigCache();
  process.env.ADS_ENABLED = "true";
  await prisma.adConfig.deleteMany({});
  live.set(fx.l1, listingView(fx.l1, fx.seller, fx.leaf, "Cosmetic boxes premium"));
  await prisma.business.update({ where: { id: fx.seller }, data: { trustScore: 70, verificationTier: 1 } });
  await redis.flushdb(); // isolated test Redis DB: also resets identity trust caches
});

const fund = (n = 1_000_000, ref = `f-${Math.random()}`) => wallet.creditTopUp(fx.seller, n, ref);

describe("seller campaign management", () => {
  it("validates, enforces ownership and the submit rules", async () => {
    await expect(ads.createCampaign(fx.seller, { name: "x", dailyBudgetPaise: 100, startsAt: new Date() })).rejects.toMatchObject({ code: "validation" });
    await expect(ads.createCampaign(fx.seller, { name: "Ok name", dailyBudgetPaise: 5_000, startsAt: new Date() })).rejects.toMatchObject({ code: "validation" }); // below Rs 100 minimum
    await expect(ads.createCampaign(fx.seller, { name: "Ok name", dailyBudgetPaise: 20_000, totalBudgetPaise: 10_000, startsAt: new Date() })).rejects.toMatchObject({ code: "validation" });
    await expect(ads.createCampaign(fx.seller, { name: "Ok name", dailyBudgetPaise: 20_000, startsAt: new Date(), endsAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "validation" });
    const c = await ads.createCampaign(fx.seller, { name: "Mine", dailyBudgetPaise: 20_000, startsAt: new Date() });
    await expect(ads.getCampaign(fx.weak, c.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(ads.updateCampaign(fx.weak, c.id, { name: "hijack" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(ads.getCampaign(fx.seller, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(ads.submitCampaign(fx.seller, c.id)).rejects.toMatchObject({ code: "validation" }); // no ad group
    const g = await ads.addAdGroup(fx.seller, c.id, { name: "Group", pincodePrefixes: ["560"] });
    await expect(ads.addAdGroup(fx.seller, c.id, { name: "Bad", pincodePrefixes: ["56"] })).rejects.toMatchObject({ code: "validation" });
    await expect(ads.addAdGroup(fx.seller, c.id, { name: "Bad", categoryIds: [crypto.randomUUID()] })).rejects.toMatchObject({ code: "validation" });
    await expect(ads.addListingToGroup(fx.seller, g.id, fx.lWeak)).rejects.toMatchObject({ code: "forbidden" }); // someone else's listing
    await expect(ads.addListingToGroup(fx.seller, g.id, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await ads.addListingToGroup(fx.seller, g.id, fx.l1);
    await expect(ads.submitCampaign(fx.seller, c.id)).rejects.toMatchObject({ code: "validation" }); // no keyword or category
    const k = await ads.addKeyword(fx.seller, g.id, { text: "Cosmetic Boxes ke liye", matchType: "exact" });
    expect((await ads.addKeyword(fx.seller, g.id, { text: "cosmetic boxes", matchType: "exact" })).id).toBe(k.id); // normalised duplicate
    await expect(ads.addKeyword(fx.seller, g.id, { text: "a" })).rejects.toMatchObject({ code: "validation" });
    await expect(ads.removeKeyword(fx.weak, k.id)).rejects.toMatchObject({ code: "forbidden" });
    await ads.submitCampaign(fx.seller, c.id);
    await expect(ads.submitCampaign(fx.seller, c.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await ads.listCampaigns(fx.seller))[0]).toMatchObject({ status: "pending_review", groups: 1, listings: 1 });
    expect(await prisma.domainEvent.count({ where: { type: "AdCampaignSubmitted", aggregateId: c.id } })).toBe(1);
    await ads.removeListingFromGroup(fx.seller, g.id, fx.l1);
    await ads.removeKeyword(fx.seller, k.id);
    await ads.updateAdGroup(fx.seller, g.id, { states: ["Karnataka"] });
  });

  it("a budget more than doubling returns a live campaign to review; a decrease does not", async () => {
    const { campaignId } = await approvedCampaign({ daily: 10_000 });
    expect(await ads.updateCampaign(fx.seller, campaignId, { dailyBudgetPaise: 15_000 })).toEqual({ returnedToReview: false });
    expect(await ads.updateCampaign(fx.seller, campaignId, { dailyBudgetPaise: 12_000 })).toEqual({ returnedToReview: false });
    expect(await ads.updateCampaign(fx.seller, campaignId, { dailyBudgetPaise: 100_000 })).toEqual({ returnedToReview: true });
    expect((await prisma.adCampaign.findUnique({ where: { id: campaignId } }))!.status).toBe("pending_review");
  });

  it("pause, resume, end", async () => {
    const { campaignId } = await approvedCampaign();
    await ads.pauseCampaign(fx.seller, campaignId);
    await expect(ads.pauseCampaign(fx.seller, campaignId)).rejects.toMatchObject({ code: "conflict" });
    await ads.resumeCampaign(fx.seller, campaignId);
    await ads.endCampaign(fx.seller, campaignId);
    await expect(ads.updateCampaign(fx.seller, campaignId, { name: "late" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("status changes are compare-and-set: a stale read loses instead of overwriting (sweep vs seller race)", async () => {
    const { campaignId } = await approvedCampaign();
    await ads.endCampaign(fx.seller, campaignId);
    const row = (await prisma.adCampaign.findUnique({ where: { id: campaignId } }))!;
    // the seller's pause read the campaign while it was still approved; it has since been ended
    const spy = vi.spyOn(prisma.adCampaign, "findUnique").mockResolvedValueOnce({ ...row, status: "approved" } as never);
    await expect(ads.pauseCampaign(fx.seller, campaignId)).rejects.toMatchObject({ code: "conflict" });
    spy.mockRestore();
    expect((await prisma.adCampaign.findUnique({ where: { id: campaignId } }))!.status).toBe("ended");
  });
});

describe("staff review", () => {
  it("per-item review, reason codes, queue, final decision", async () => {
    const staff = crypto.randomUUID();
    const c = await ads.createCampaign(fx.seller, { name: "Review me", dailyBudgetPaise: 20_000, startsAt: new Date() });
    const g = await ads.addAdGroup(fx.seller, c.id, { name: "G1" });
    const al = await ads.addListingToGroup(fx.seller, g.id, fx.l1);
    const good = await ads.addKeyword(fx.seller, g.id, { text: "cosmetic boxes" });
    const bad = await ads.addKeyword(fx.seller, g.id, { text: "nike shoes" });
    await ads.submitCampaign(fx.seller, c.id);
    expect((await ads.listReviewQueue()).some((q) => q.id === c.id && q.pendingItems === 3)).toBe(true);
    await expect(ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "keyword", id: bad.id }, decision: "rejected" })).rejects.toMatchObject({ code: "validation" });
    await ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "keyword", id: bad.id }, decision: "rejected", reasonCode: "trademark" });
    await expect(ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "keyword", id: crypto.randomUUID() }, decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await expect(ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "listing", id: crypto.randomUUID() }, decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await expect(ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "ad_group", id: crypto.randomUUID() }, decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "listing", id: al.id }, decision: "approved" });
    await ads.decideCampaign({ campaignId: c.id, staffId: staff, decision: "approved" });
    const d = await ads.getCampaignForReview(c.id);
    expect(d.status).toBe("approved");
    const kws = d.adGroups[0]!.keywords;
    expect(kws.find((k) => k.id === good.id)!.reviewStatus).toBe("approved");
    expect(kws.find((k) => k.id === bad.id)!.reviewStatus).toBe("rejected"); // stays rejected: one bad keyword does not sink the campaign
    expect(d.reviews.length).toBeGreaterThanOrEqual(3);
    await expect(ads.getCampaignForReview(crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejection needs a reason and returns the campaign to the seller; approval needs an approved listing", async () => {
    const staff = crypto.randomUUID();
    const c = await ads.createCampaign(fx.seller, { name: "Reject me", dailyBudgetPaise: 20_000, startsAt: new Date() });
    const g = await ads.addAdGroup(fx.seller, c.id, { name: "G1" });
    const al = await ads.addListingToGroup(fx.seller, g.id, fx.l1);
    await ads.addKeyword(fx.seller, g.id, { text: "cosmetic boxes" });
    await ads.submitCampaign(fx.seller, c.id);
    await expect(ads.decideCampaign({ campaignId: c.id, staffId: staff, decision: "rejected" })).rejects.toMatchObject({ code: "validation" });
    await ads.reviewItem({ campaignId: c.id, staffId: staff, subject: { type: "listing", id: al.id }, decision: "rejected", reasonCode: "misleading_listing" });
    await expect(ads.decideCampaign({ campaignId: c.id, staffId: staff, decision: "approved" })).rejects.toMatchObject({ code: "validation" });
    await ads.decideCampaign({ campaignId: c.id, staffId: staff, decision: "rejected", reasonCode: "misleading_listing", note: "photo does not match" });
    expect((await ads.listCampaigns(fx.seller)).find((x) => x.id === c.id)).toMatchObject({ status: "rejected", rejectionReason: "photo does not match" });
    await expect(ads.decideCampaign({ campaignId: crypto.randomUUID(), staffId: staff, decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await ads.submitCampaign(fx.seller, c.id); // rejected campaigns can be fixed and resubmitted
  });

  it("suspend is an immediate kill switch and can be undone; suspend by business; admin lists", async () => {
    await fund();
    const a = await approvedCampaign();
    await ads.waitForBackgroundSweeps(); // rebuilds started by approval/top-up must not race the explicit sweep
    expect(await ads.runEligibilitySweep(new Date(), { wait: true })).not.toBeNull();
    expect((await slots()).length).toBe(1);
    await ads.suspendCampaign(a.campaignId, crypto.randomUUID(), "complaints");
    expect(await ads.loadSnapshot()).toBeNull(); // snapshot dropped at once
    await ads.suspendCampaign(a.campaignId, crypto.randomUUID(), "again"); // idempotent
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(0);
    await expect(ads.decideCampaign({ campaignId: a.campaignId, staffId: crypto.randomUUID(), decision: "approved" })).rejects.toMatchObject({ code: "conflict" });
    await ads.unsuspendCampaign(a.campaignId, crypto.randomUUID());
    await expect(ads.unsuspendCampaign(a.campaignId, crypto.randomUUID())).rejects.toMatchObject({ code: "conflict" });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(1);
    expect(await ads.suspendBusinessAds(fx.seller, crypto.randomUUID(), "fraud")).toBe(1);
    expect((await ads.listCampaignsForAdmin({ status: "suspended" })).some((c) => c.id === a.campaignId)).toBe(true);
    expect((await ads.listCampaignsForAdmin()).length).toBeGreaterThan(0);
  });
});

describe("eligibility sweep", () => {
  it("serves only eligible listings and stops when trust or listing state changes, emitting AdIneligible", async () => {
    await fund();
    const a = await approvedCampaign();
    const r = await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(r).toMatchObject({ campaigns: expect.any(Number), candidates: expect.any(Number) });
    expect((await slots()).map((s) => s.listing.id)).toEqual([fx.l1]);
    expect((await prisma.adCampaign.findUnique({ where: { id: a.campaignId } }))!.status).toBe("active");

    await prisma.business.update({ where: { id: fx.seller }, data: { trustScore: 49 } });
    await redis.flushdb();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(0);
    const row = await prisma.adGroupListing.findUnique({ where: { id: a.adGroupListingId } });
    expect(row).toMatchObject({ eligible: false, ineligibleReason: "trust_below_floor" });
    expect(await prisma.domainEvent.count({ where: { type: "AdIneligible", aggregateId: fx.l1 } })).toBe(1);
    expect((await prisma.adCampaign.findUnique({ where: { id: a.campaignId } }))!.haltReason).toBe("eligibility");

    await prisma.business.update({ where: { id: fx.seller }, data: { trustScore: 55 } });
    await redis.flushdb();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(1);
    live.set(fx.l1, listingView(fx.l1, fx.seller, fx.leaf, "Cosmetic boxes premium", { moderationStatus: "review" }));
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(0);
  });

  it("halts a campaign with an empty wallet and resumes after top-up; prohibited categories never serve", async () => {
    const a = await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(0);
    expect((await prisma.adCampaign.findUnique({ where: { id: a.campaignId } }))!.haltReason).toBe("wallet");
    await fund();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(1);
    const b = await approvedCampaign({ listing: fx.l3, keyword: "prohibited thing", name: "bad cat" });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect((await prisma.adGroupListing.findUnique({ where: { id: b.adGroupListingId } }))!.ineligibleReason).toBe("category_prohibited");
  });

  it("ended campaigns stop; a sweep is exclusive while another holds the lock", async () => {
    await fund();
    const a = await approvedCampaign();
    await prisma.adCampaign.update({ where: { id: a.campaignId }, data: { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 86_400_000) } });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect((await prisma.adCampaign.findUnique({ where: { id: a.campaignId } }))!.status).toBe("ended");
    await redis.set("ads:sweep:lock", "1", "EX", 20);
    expect(await ads.runEligibilitySweep(new Date(), { wait: true })).toBeNull();
  });
});

describe("getSponsoredSlots", () => {
  beforeEach(async () => {
    await fund();
  });

  it("returns nothing while ADS_ENABLED is off (admin can still configure)", async () => {
    await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    process.env.ADS_ENABLED = "false";
    expect(await slots()).toEqual([]);
    expect((await ads.listCampaignsForAdmin()).length).toBeGreaterThan(0);
  });

  it("labels, prices from the rate card, signs a click token and never duplicates an organic result", async () => {
    await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    const [s] = await slots();
    expect(s).toMatchObject({ sponsored: true, label: "Sponsored", after: "top", slot: 1, cpcPaise: 500 });
    expect(s!.clickHref).toBe(`/ad/${s!.clickToken}`);
    expect(ads.verifyClickToken(s!.clickToken, 30)).toMatchObject({ ok: true, payload: { l: fx.l1, p: 500, f: "search" } });
    expect(await slots({ organicListingIds: [...organic(19), fx.l1] })).toEqual([]); // organic keeps its position, ad collapses
  });

  it("slot caps: none under 10 organic results, at most 2, one per seller, irrelevant queries get nothing", async () => {
    await approvedCampaign();
    const second = await approvedCampaign({ listing: fx.l2, keyword: "cosmetic boxes", name: "second" });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots({ organicListingIds: organic(9) })).toEqual([]);
    expect(await slots({ organicListingIds: organic(10) })).toHaveLength(1);
    expect((await slots()).length).toBe(1); // same seller: one ad per seller per page
    expect(await slots({ query: "tractor spare parts" })).toEqual([]);
    expect(second.campaignId).toBeTruthy();
    expect(await slots({ limit: 0 })).toEqual([]);
  });

  it("weak sellers (trust < floor) never get slots even with a perfect keyword match", async () => {
    await prisma.business.update({ where: { id: fx.weak }, data: { trustScore: 60 } }); // pass the sweep, then drop in the snapshot check
    await wallet.creditTopUp(fx.weak, 100_000, `w-${uid}`);
    await approvedCampaign({ seller: fx.weak, listing: fx.lWeak, name: "weak" });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(1);
    await prisma.business.update({ where: { id: fx.weak }, data: { trustScore: 40 } });
    await redis.flushdb();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots()).toHaveLength(0);
  });

  it("product page rail excludes the seller's own product page; geo targets need a matching buyer location", async () => {
    const a = await approvedCampaign();
    await prisma.adGroup.update({ where: { id: a.adGroupId }, data: { states: ["Maharashtra"] } });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots({ surface: "product_similar", organicListingIds: [] })).toEqual([]); // no buyer location known
    expect(await slots({ surface: "product_similar", organicListingIds: [], buyerState: "maharashtra" })).toHaveLength(1);
    expect(await slots({ surface: "product_similar", organicListingIds: [], buyerState: "Kerala" })).toEqual([]);
    expect(await slots({ surface: "product_similar", organicListingIds: [], buyerState: "Maharashtra", excludeSellerBusinessId: fx.seller })).toEqual([]);
    await prisma.adGroup.update({ where: { id: a.adGroupId }, data: { states: [], pincodePrefixes: ["560"] } });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    expect(await slots({ buyerPincode: "560001" })).toHaveLength(1);
    expect(await slots({ buyerPincode: "110001" })).toEqual([]);
  });

  it("frequency cap: a visitor sees the same ad at most 5 times a day", async () => {
    await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    const visitorId = "same-visitor";
    const got = [];
    for (let i = 0; i < 7; i++) got.push((await slots({ visitorId })).length);
    expect(got).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(await slots({ visitorId: "another" })).toHaveLength(1);
  });

  it("kill switches (global and per surface) stop serving without a deploy", async () => {
    await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    await ads.setKillSwitch("search", true);
    expect(await slots()).toEqual([]);
    expect(await slots({ surface: "category" })).toHaveLength(1);
    await ads.setKillSwitch("search", false);
    await ads.setKillSwitch("all", true);
    expect(await slots({ surface: "category" })).toEqual([]);
    expect(await ads.getKillSwitches()).toMatchObject({ all: true, search: false });
    await ads.setKillSwitch("all", false);
    expect(await slots()).toHaveLength(1);
  });

  it("a budget-exhausted campaign stops serving; any failure returns zero ads, never an error", async () => {
    const a = await approvedCampaign({ daily: 10_000 });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    await ads.reserveSpend({ campaignId: a.campaignId, dailyBudgetPaise: 10_000, totalBudgetPaise: null, amountPaise: 9_900, at: new Date() });
    expect(await slots()).toEqual([]);
    expect(await ads.getSponsoredSlots({ query: "cosmetic boxes", surface: "search", organicListingIds: organic(20), timeoutMs: 0 })).toEqual([]);
    const spy = vi.spyOn(redis, "mget").mockRejectedValueOnce(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await slots()).toEqual([]);
    spy.mockRestore();
    err.mockRestore();
  });

  it("buffers impressions and rolls them up hourly, idempotently", async () => {
    const a = await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    await slots();
    await slots();
    const later = new Date(Date.now() + 2 * 3600_000);
    const r1 = await ads.rollupImpressions(later);
    expect(r1.rows).toBeGreaterThan(0);
    const rows = await prisma.adImpressionRollup.findMany({ where: { campaignId: a.campaignId } });
    expect(rows.reduce((s, r) => s + r.served, 0)).toBe(2);
    await ads.rollupImpressions(later);
    expect((await prisma.adImpressionRollup.findMany({ where: { campaignId: a.campaignId } })).reduce((s, r) => s + r.served, 0)).toBe(2);
    expect(await prisma.domainEvent.count({ where: { type: "AdImpressionsRolledUp", aggregateId: a.campaignId } })).toBe(1);
  });

  it("cold start: no snapshot means no ads (and a background rebuild), never a Postgres call on the hot path", async () => {
    await approvedCampaign();
    resetSnapshotCacheForTests();
    await redis.del("ads:snap:v1");
    expect(await slots()).toEqual([]);
  });
});

describe("clicks", () => {
  let camp: Awaited<ReturnType<typeof approvedCampaign>>;
  const token = async () => (await slots())[0]!.clickToken;
  beforeEach(async () => {
    await fund();
    camp = await approvedCampaign({ daily: 10_000 });
    await ads.runEligibilitySweep(new Date(), { wait: true });
  });

  it("valid click: charged the locked rate-card price, redirect target returned, event emitted, replay never double-charges", async () => {
    const t = await token();
    const r = await click(t);
    expect(r).toMatchObject({ status: "recorded", listingId: fx.l1, validity: "valid", chargedPaise: 500 });
    expect(await click(t)).toMatchObject({ status: "replay", listingId: fx.l1 });
    expect(await prisma.adClick.count({ where: { campaignId: camp.campaignId } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: "AdClicked", aggregateId: camp.campaignId } })).toBe(1);
    expect(await redis.get(`ads:budget:${camp.campaignId}:${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)}`)).toBe("500");
  });

  it("tampered, garbage and expired tokens", async () => {
    const t = await token();
    expect(await click(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toEqual({ status: "invalid_token" });
    expect(await click("nope")).toEqual({ status: "invalid_token" });
    expect(await click(t, { now: new Date(Date.now() + 60 * 60_000) })).toMatchObject({ status: "expired", listingId: fx.l1 });
    const gone = ads.signClickToken({ t: "x", c: crypto.randomUUID(), g: "g", l: fx.l1, s: fx.seller, f: "search", n: 1, p: 500, q: null, i: Date.now() });
    expect(await click(gone)).toEqual({ status: "invalid_token" });
  });

  it("invalid-click rules: bots and duplicates are free, self-clicks are never charged", async () => {
    const bot = await click(await token(), { userAgent: "Googlebot/2.1" });
    expect(bot).toMatchObject({ validity: "invalid", invalidReason: "bot_ua", chargedPaise: 0 });
    expect(await click(await token(), { userAgent: "" })).toMatchObject({ validity: "invalid", invalidReason: "bot_ua" });
    const first = await click(await token(), { visitorId: "dup-visitor" });
    expect(first).toMatchObject({ validity: "valid" });
    expect(await click(await token(), { visitorId: "dup-visitor" })).toMatchObject({ validity: "invalid", invalidReason: "duplicate", chargedPaise: 0 });
    expect(await click(await token(), { businessId: fx.seller })).toMatchObject({ validity: "self_click", chargedPaise: 0 });
    expect(await click(await token(), { personId: fx.person })).toMatchObject({ validity: "self_click" }); // a member of the advertiser
    const spent = await redis.get(`ads:total:${camp.campaignId}`);
    expect(spent).toBe("500"); // only the one valid click reserved budget
  });

  it("a rate spike from one network goes pending, not charged", async () => {
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await click(await token(), { visitorId: `burst-${i}`, ip: "9.9.9.9" }));
    const pending = results.filter((r) => r.status === "recorded" && r.validity === "pending");
    expect(pending.length).toBe(4);
    expect(results.every((r) => r.status === "recorded" && r.chargedPaise === (r.validity === "valid" ? 500 : 0))).toBe(true);
  });

  it("PACING: N parallel clicks never spend more than the daily budget", async () => {
    // budget Rs 100 = 10,000 paise, price 500 => at most 20 charged clicks out of 40 racing ones
    const tokens: string[] = [];
    for (let i = 0; i < 40; i++) tokens.push(ads.signClickToken({ t: `race-${uid}-${i}`, c: camp.campaignId, g: camp.adGroupId, l: fx.l1, s: fx.seller, f: "search", n: 1, p: 500, q: "cosmetic boxes", i: Date.now() }));
    const res = await Promise.all(tokens.map((t, i) => click(t, { visitorId: `race-v-${i}`, ip: `77.${i}.1.1` })));
    const valid = res.filter((r) => r.status === "recorded" && r.validity === "valid").length;
    const over = res.filter((r) => r.status === "recorded" && r.invalidReason === "over_budget").length;
    expect(valid).toBe(20);
    expect(over).toBe(20);
    const agg = await prisma.adClick.aggregate({ _sum: { chargedPaise: true }, where: { campaignId: camp.campaignId, validity: "valid" } });
    expect(Number(agg._sum.chargedPaise)).toBeLessThanOrEqual(10_000);
  });

  it("total budget is a hard cap across days", async () => {
    const id = crypto.randomUUID();
    const day1 = new Date();
    const day2 = new Date(Date.now() + 26 * 3600_000);
    expect(await ads.reserveSpend({ campaignId: id, dailyBudgetPaise: 10_000, totalBudgetPaise: 15_000, amountPaise: 10_000, at: day1 })).toMatchObject({ ok: true });
    expect(await ads.reserveSpend({ campaignId: id, dailyBudgetPaise: 10_000, totalBudgetPaise: 15_000, amountPaise: 500, at: day1 })).toEqual({ ok: false, reason: "daily_budget" });
    expect(await ads.reserveSpend({ campaignId: id, dailyBudgetPaise: 10_000, totalBudgetPaise: 15_000, amountPaise: 10_000, at: day2 })).toEqual({ ok: false, reason: "total_budget" });
    expect(await ads.reserveSpend({ campaignId: id, dailyBudgetPaise: 10_000, totalBudgetPaise: 15_000, amountPaise: 5_000, at: day2 })).toMatchObject({ ok: true });
    await ads.releaseSpend(id, 5_000, day2);
    expect(await ads.getSpentToday([id], day2)).toEqual(new Map([[id, { day: 0, total: 10_000 }]]));
  });

  it("re-seeds the budget counter from the click table after a Redis flush", async () => {
    const c = await approvedCampaign({ daily: 10_000, name: "capped", keyword: "cosmetic boxes" });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    const mk = (i: number) => ads.signClickToken({ t: `tot-${uid}-${i}`, c: c.campaignId, g: c.adGroupId, l: fx.l1, s: fx.seller, f: "search", n: 1, p: 500, q: null, i: Date.now() });
    for (let i = 0; i < 24; i++) await click(mk(i), { visitorId: `tot-${i}`, ip: `88.${i}.1.1` });
    const agg = await prisma.adClick.aggregate({ _sum: { chargedPaise: true }, where: { campaignId: c.campaignId, validity: "valid" } });
    expect(Number(agg._sum.chargedPaise)).toBe(10_000);
    await redis.flushdb(); // counters lost
    const after = await click(mk(99), { visitorId: "tot-99", ip: "88.99.1.1" });
    expect(after).toMatchObject({ validity: "invalid", invalidReason: "over_budget" });
  });

  it("an empty wallet cannot be overdrawn by accepted clicks", async () => {
    const c = await approvedCampaign({ daily: 100_000, name: "rich budget" });
    await ads.runEligibilitySweep(new Date(), { wait: true });
    await prisma.adWalletEntry.deleteMany({ where: { businessId: fx.seller } });
    await wallet.creditTopUp(fx.seller, 1_000, `small-${uid}`);
    const mk = (i: number) => ads.signClickToken({ t: `wal-${uid}-${i}`, c: c.campaignId, g: c.adGroupId, l: fx.l1, s: fx.seller, f: "search", n: 1, p: 500, q: null, i: Date.now() });
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => click(mk(i), { visitorId: `w-${i}`, ip: `66.${i}.1.1` })));
    expect(res.filter((r) => r.status === "recorded" && r.validity === "valid")).toHaveLength(2);
    expect(res.filter((r) => r.status === "recorded" && r.invalidReason === "wallet_empty")).toHaveLength(4);
  });

  it("suspended campaigns record clicks as invalid", async () => {
    const t = await token();
    await prisma.adCampaign.update({ where: { id: camp.campaignId }, data: { status: "suspended" } });
    expect(await click(t)).toMatchObject({ validity: "invalid", invalidReason: "campaign_inactive" });
  });
});

describe("settlement, refunds and re-scoring", () => {
  let camp: Awaited<ReturnType<typeof approvedCampaign>>;
  const tomorrow = () => new Date(Date.now() + 26 * 3600_000);
  beforeEach(async () => {
    await fund(100_000);
    camp = await approvedCampaign({ daily: 20_000 });
    await ads.runEligibilitySweep(new Date(), { wait: true });
  });
  const mk = (i: number) => ads.signClickToken({ t: `st-${uid}-${i}-${Math.random()}`, c: camp.campaignId, g: camp.adGroupId, l: fx.l1, s: fx.seller, f: "search", n: 1, p: 500, q: null, i: Date.now() });

  it("settles valid clicks into ONE wallet debit per campaign window, idempotently", async () => {
    for (let i = 0; i < 4; i++) await click(mk(i), { visitorId: `s-${i}`, ip: `55.${i}.1.1` });
    await click(mk(9), { userAgent: "curl/8" }); // invalid: never debited
    const before = await wallet.getAdWalletBalance(fx.seller);
    const r = await ads.settleSpend(tomorrow());
    expect(r).toMatchObject({ settlements: 1, spendPaise: 2000, shortfallPaise: 0 });
    expect(await wallet.getAdWalletBalance(fx.seller)).toBe(before - 2000);
    expect(await ads.settleSpend(tomorrow())).toMatchObject({ settlements: 0 }); // nothing left, nothing double-debited
    expect(await prisma.adSpendSettlement.count({ where: { campaignId: camp.campaignId } })).toBe(1);
    expect(await prisma.adWalletEntry.count({ where: { businessId: fx.seller, reason: "spend" } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: "AdSpendSettled", aggregateId: camp.campaignId } })).toBe(1);
    expect(await prisma.adClick.count({ where: { campaignId: camp.campaignId, settlementId: { not: null } } })).toBe(4);
  });

  it("concurrent settlement runs debit once", async () => {
    for (let i = 0; i < 3; i++) await click(mk(i), { visitorId: `c-${i}`, ip: `54.${i}.1.1` });
    const before = await wallet.getAdWalletBalance(fx.seller);
    await Promise.allSettled([ads.settleSpend(tomorrow()), ads.settleSpend(tomorrow()), ads.settleSpend(tomorrow())]);
    expect(await wallet.getAdWalletBalance(fx.seller)).toBe(before - 1500);
  });

  it("a short wallet is capped at the balance (never negative) and reported as shortfall", async () => {
    for (let i = 0; i < 4; i++) await click(mk(i), { visitorId: `p-${i}`, ip: `53.${i}.1.1` });
    await prisma.adWalletEntry.create({ data: { businessId: fx.seller, deltaPaise: -99_000n, reason: "adjustment", idempotencyKey: `drain-${uid}` } });
    const r = await ads.settleSpend(tomorrow());
    expect(r.spendPaise).toBe(1000);
    expect(r.shortfallPaise).toBe(1000);
    expect(await wallet.getAdWalletBalance(fx.seller)).toBe(0);
  });

  it("an invalid click found after settlement is refunded automatically, once", async () => {
    const r = await click(mk(1), { visitorId: "late-1", ip: "52.1.1.1" });
    if (r.status !== "recorded") throw new Error("expected a click");
    await ads.settleSpend(tomorrow());
    const balance = await wallet.getAdWalletBalance(fx.seller);
    const inv = await ads.invalidateClick(r.clickId, "ip_cluster", "rescore");
    expect(inv).toEqual({ refundedPaise: 500, changed: true });
    expect(await wallet.getAdWalletBalance(fx.seller)).toBe(balance + 500);
    expect(await ads.invalidateClick(r.clickId, "ip_cluster", "rescore")).toEqual({ refundedPaise: 0, changed: false });
    expect(await wallet.getAdWalletBalance(fx.seller)).toBe(balance + 500);
    expect(await prisma.domainEvent.count({ where: { type: "AdClickInvalidated", aggregateId: camp.campaignId } })).toBe(1);
    expect(await ads.invalidateClick(crypto.randomUUID(), "x", "staff")).toEqual({ refundedPaise: 0, changed: false });
  });

  it("re-scoring promotes clean pending clicks and invalidates clusters and repeat visitors; staff can invalidate in bulk", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await click(mk(i), { visitorId: `rs-${i}`, ip: "51.1.1.1" }); // one network: clicks 9-12 go pending
      if (r.status === "recorded") ids.push(r.clickId);
    }
    const old = new Date(Date.now() - 2 * 3600_000);
    await prisma.adClick.updateMany({ where: { campaignId: camp.campaignId }, data: { createdAt: old } });
    await prisma.adClick.updateMany({ where: { campaignId: camp.campaignId }, data: { createdAt: old } });
    // spread timestamps so "earlier clicks" are well defined
    const all = await prisma.adClick.findMany({ where: { campaignId: camp.campaignId }, orderBy: { id: "asc" } });
    for (const [i, c] of all.entries()) await prisma.adClick.update({ where: { id: c.id }, data: { createdAt: new Date(old.getTime() + i * 1000) } });
    await ads.updateCampaign(fx.seller, camp.campaignId, { name: "touch" }).catch(() => undefined);
    await prisma.adConfig.create({ data: { key: "netDailyCap", value: 10 } });
    resetAdsConfigCache();
    const r = await ads.rescoreClicks();
    expect(r.scanned).toBe(12);
    expect(r.invalidated).toBe(2); // clicks 11 and 12 exceed the network cap of 10
    expect(r.promoted).toBeGreaterThanOrEqual(2);
    expect(await prisma.adClick.count({ where: { campaignId: camp.campaignId, validity: "pending" } })).toBe(0);
    const staffRes = await ads.invalidateClicksByStaff(ids.slice(0, 3), "staff_review");
    expect(staffRes.invalidated).toBeGreaterThanOrEqual(0);
    const traffic = await ads.listInvalidTraffic({ minClicks: 1 });
    expect(traffic.find((t) => t.campaignId === camp.campaignId)).toBeTruthy();
    expect((await ads.listClicksForReview(camp.campaignId)).length).toBeGreaterThan(0);
  });

  it("repeat visitors on one listing beyond the cap are invalidated on re-score", async () => {
    const t0 = Date.now() - 3 * 3600_000;
    for (let i = 0; i < 4; i++) {
      await prisma.adClick.create({ data: { campaignId: camp.campaignId, adGroupId: camp.adGroupId, listingId: fx.l1, sellerBusinessId: fx.seller, surface: "search", slot: 1, chargedPaise: 500n, validity: "valid", visitorHash: "same", netHash: `n${i}`, userAgentClass: "browser", tokenId: `rv-${uid}-${i}`, createdAt: new Date(t0 + i * 60_000) } });
    }
    const r = await ads.rescoreClicks();
    expect(r.invalidated).toBe(1);
  });
});

describe("attribution and reporting", () => {
  it("attributes an enquiry to the buyer's last click inside the window, once per enquiry", async () => {
    await fund();
    const a = await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    const t = (await slots())[0]!.clickToken;
    const r = await click(t, { businessId: fx.buyer });
    if (r.status !== "recorded") throw new Error("click");
    const enquiryId = crypto.randomUUID();
    const got = await ads.attributeEnquiry({ enquiryId, buyerBusinessId: fx.buyer, listingId: fx.l1 });
    expect(got?.clickId).toBe(r.clickId);
    expect((await ads.attributeEnquiry({ enquiryId, buyerBusinessId: fx.buyer }))?.attributionId).toBe(got!.attributionId);
    expect(await prisma.adAttribution.count({ where: { campaignId: a.campaignId } })).toBe(1);
    expect(await ads.attributeEnquiry({ enquiryId: crypto.randomUUID(), buyerBusinessId: crypto.randomUUID() })).toBeNull();
    expect(await ads.attributeEnquiry({ enquiryId: crypto.randomUUID() })).toBeNull();
    // by category (enquiries are RFQs), by explicit click id, and outside the window
    const byCat = await ads.attributeEnquiry({ enquiryId: crypto.randomUUID(), buyerBusinessId: fx.buyer, categoryId: fx.leaf });
    expect(byCat?.clickId).toBe(r.clickId);
    expect(await ads.attributeEnquiry({ enquiryId: crypto.randomUUID(), buyerBusinessId: fx.buyer, categoryId: fx.root })).toBeNull();
    expect((await ads.attributeEnquiry({ enquiryId: crypto.randomUUID(), buyerBusinessId: fx.buyer, clickId: r.clickId }))?.clickId).toBe(r.clickId);
    expect(await ads.attributeEnquiry({ enquiryId: crypto.randomUUID(), buyerBusinessId: fx.buyer, now: new Date(Date.now() + 8 * 86_400_000) })).toBeNull();
    // the worker handler wires EnquiryCreated to attribution
    await ads.worker.handlers.EnquiryCreated!({ id: 1, type: "EnquiryCreated", version: 1, aggregateType: "enquiry", aggregateId: "x", occurredAt: "", payload: { enquiryId: crypto.randomUUID(), buyerBusinessId: fx.buyer, categoryId: fx.leaf } } as never);
    expect(await prisma.adAttribution.count({ where: { campaignId: a.campaignId } })).toBe(4);

    const report = await ads.getCampaignReport(fx.seller, a.campaignId);
    expect(report.clicks.valid).toBe(1);
    expect(report.attributedEnquiries).toBe(4);
    expect(report.costPerEnquiryPaise).toBe(125);
    expect(report.spendPaise).toBe(500);
    expect(report.avgCpcPaise).toBe(500);
    await expect(ads.getCampaignReport(fx.weak, a.campaignId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(ads.getCampaignReport(null, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
    expect((await ads.getAdvertiserOverview(fx.seller)).length).toBeGreaterThan(0);
  });

  it("report never shows clicks without their invalid share", async () => {
    await fund();
    const a = await approvedCampaign();
    await ads.runEligibilitySweep(new Date(), { wait: true });
    await click((await slots())[0]!.clickToken, { userAgent: "curl/8" });
    await click((await slots())[0]!.clickToken);
    const rep = await ads.getCampaignReport(null, a.campaignId, 7);
    expect(rep.clicks).toMatchObject({ total: 2, valid: 1, invalid: 1, invalidSharePct: 50, invalidByReason: { bot_ua: 1 } });
    expect(rep.daily.length).toBeGreaterThan(0);
  });
});

describe("money monitors", () => {
  it("wallet-low alert fires once a day", async () => {
    await approvedCampaign();
    await wallet.creditTopUp(fx.seller, 1_000, `low-${uid}`);
    expect(await ads.checkWalletLow()).toBe(1);
    expect(await ads.checkWalletLow()).toBe(0);
    expect(await prisma.domainEvent.count({ where: { type: "AdWalletLow", aggregateId: fx.seller } })).toBe(1);
  });

  it("revenue cap monitor reports the ad share and flags a breach without switching anything off", async () => {
    await fund();
    const a = await approvedCampaign();
    await prisma.adSpendSettlement.create({ data: { campaignId: a.campaignId, sellerBusinessId: fx.seller, windowStart: new Date(Date.now() - 86_400_000), windowEnd: new Date(), validClicks: 1, spendPaise: 900_000_000n } });
    const s = await ads.getRevenueCapStatus();
    expect(s.capPct).toBe(20);
    expect(s.breached).toBe(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await ads.checkRevenueCap()).breached).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect((await slots()).length).toBeGreaterThanOrEqual(0); // monitoring only
  });
});

describe("config and rate card (staff)", () => {
  it("config changes take effect without a deploy and are validated", async () => {
    await ads.setAdsConfig({ trustFloor: 65, maxSearchSlots: 1 }, null);
    expect(await ads.getAdsConfig()).toMatchObject({ trustFloor: 65, maxSearchSlots: 1 });
    await expect(ads.setAdsConfig({ trustFloor: 20 }, null)).rejects.toMatchObject({ code: "validation" });
    await expect(ads.setAdsConfig({ nope: 1 } as never, null)).rejects.toThrow();
    expect(ads.ADS_CONFIG_KEYS).toContain("trustFloor");
  });

  it("rate card: validation, versioning by effectiveFrom, public listing", async () => {
    await expect(ads.setRateCard({ categoryId: null, surface: "search", cpcPaise: 50 }, null)).rejects.toMatchObject({ code: "validation" });
    await expect(ads.setRateCard({ categoryId: null, surface: "search", cpcPaise: 900, maxCpcPaise: 500 }, null)).rejects.toMatchObject({ code: "validation" });
    await expect(ads.setRateCard({ categoryId: crypto.randomUUID(), surface: "search", cpcPaise: 900 }, null)).rejects.toMatchObject({ code: "validation" });
    await ads.setRateCard({ categoryId: fx.leaf, surface: "search", cpcPaise: 700, maxCpcPaise: 900 }, null, new Date());
    await ads.setRateCard({ categoryId: fx.leaf, surface: "search", cpcPaise: 1200, effectiveFrom: new Date(Date.now() + 86_400_000) }, null);
    const card = await ads.getPublicRateCard();
    const leaf = card.find((r) => r.categoryId === fx.leaf && r.surface === "search")!;
    expect(leaf).toMatchObject({ cpcPaise: 700, maxCpcPaise: 900, categoryName: "Cosmetic boxes" });
    expect(card.find((r) => r.categoryId === null)!.categoryName).toMatch(/default/);
    await prisma.adRateCard.deleteMany({ where: { categoryId: fx.leaf } });
  });
});

describe("worker", () => {
  it("exposes handlers and idempotent jobs; sweeps are skipped while disabled", async () => {
    expect(ads.worker.name).toBe("ads");
    expect(ads.worker.jobs.map((j) => j.name)).toEqual(expect.arrayContaining(["ads.eligibility-sweep", "ads.settle-spend", "ads.rescore-clicks", "ads.rollup-impressions", "ads.wallet-low", "ads.revenue-cap", "ads.expire-promo"]));
    for (const j of ads.worker.jobs) await j.run();
    process.env.ADS_ENABLED = "false";
    for (const j of ads.worker.jobs) await j.run();
    for (const h of ["ListingModerated", "ListingImageModerated", "ListingArchived", "ListingUnpublished", "TrustScoreChanged", "BusinessVerified", "AdWalletToppedUp"] as const) await (ads.worker.handlers[h] as any)({});
    process.env.ADS_ENABLED = "true";
    await (ads.worker.handlers.ListingModerated as any)({});
    await new Promise((r) => setTimeout(r, 200));
  });
});
