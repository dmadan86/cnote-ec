// Per-line awards by team members: roles, approval rules and spend limits apply (docs/design/buyer-approvals.md), plus input guards.
import { getSpentPaise, savePolicy, setSpendLimit } from "@cnote/approvals";
import { grantCredits } from "@cnote/billing";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  candidates: [] as { sellerBusinessId: string; listingId: string; similarity: number }[],
  profiles: new Map<string, unknown>(),
}));

vi.mock("@cnote/ai", () => ({
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false }),
  embed: async () => ({ vectors: [Array.from({ length: 256 }, (_, i) => (i % 5) / 5)], version: "test" }),
  scoreIntent: async () => ({ score: 80, reasons: ["Specific quantity"], decisionId: "d", confidence: 0.9, needsReview: false }),
}));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => true }));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  listCategories: async () => [],
  getListing: async () => null,
  getPublicListing: async () => null,
  findSellerCandidates: async () => state.candidates,
}));
// real roles from BusinessMember rows (getMemberRole / can); only trust, consent and contact are faked
vi.mock("@cnote/identity", async (orig) => ({
  ...(await orig<typeof import("@cnote/identity")>()),
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => state.profiles.has(i)).map((i) => [i, state.profiles.get(i)])),
  hasConsent: async () => true,
  getPersonContact: async () => ({ phone: "+919999900000" }),
}));

import { acceptLead, applyLineAwards, awardLines, createEnquiry, sendQuote } from "../src";

const tag = `awm-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const sellers: { personId: string; businessId: string }[] = [];

async function person(name: string, businessId: string, role: "owner" | "requester" | "viewer") {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}`, email: `${randomUUID()}@example.test` } });
  await prisma.businessMember.create({ data: { businessId, personId: p.id, role } });
  personIds.push(p.id);
  return p.id;
}
async function seller(name: string) {
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, city: "Pune" } });
  bizIds.push(b.id);
  const personId = await person(name, b.id, "owner");
  state.profiles.set(b.id, { businessId: b.id, name: `${tag}-${name}`, city: "Pune", state: "MH", pincode: "411001", verificationTier: 2, trustScore: 62, badgeActive: true, languages: ["en"] });
  await grantCredits(b.id, 40, "test", { refType: "test", refId: "g" });
  return { personId, businessId: b.id };
}
async function team() {
  const b = await prisma.business.create({ data: { name: `${tag}-buyer-${randomUUID().slice(0, 6)}`, city: "Pune" } });
  bizIds.push(b.id);
  state.profiles.set(b.id, { businessId: b.id, name: b.name, city: "Pune", state: "MH", pincode: "411001", verificationTier: 1, trustScore: 60, badgeActive: true, languages: ["en"] });
  const owner = await person("owner", b.id, "owner");
  const requester = { personId: await person("requester", b.id, "requester"), businessId: b.id };
  const viewer = { personId: await person("viewer", b.id, "viewer"), businessId: b.id };
  return { businessId: b.id, owner, requester, viewer };
}

/** a 2-line RFQ by `buyer`, one supplier accepts and quotes both lines (10 and 20 paise per unit) */
async function quoted(buyer: { personId: string; businessId: string }) {
  const e = await createEnquiry(buyer, {
    title: "Fasteners for line 5", requirement: "Monthly fasteners order for assembly line five",
    lines: [{ itemName: "M6 bolt", quantity: 1000, unit: "pcs" }, { itemName: "M6 nut", quantity: 1000, unit: "pcs" }],
  }, { buyerPhoneVerified: true });
  enquiryIds.push(e.id);
  const m = e.matches[0]!;
  const s = sellers.find((x) => x.businessId === m.sellerBusinessId)!;
  const lead = await acceptLead(s, m.id);
  const { quoteId } = await sendQuote(s, lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 10 }, { ordinal: 2, unitPricePaise: 20 }] });
  return { e, quoteId, sellerBusinessId: s.businessId };
}

beforeAll(async () => {
  sellers.push(await seller("s1"));
  state.candidates = sellers.map((s) => ({ sellerBusinessId: s.businessId, listingId: randomUUID(), similarity: 0.9 }));
});

afterAll(async () => {
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  const matchIds = (await prisma.match.findMany({ where: { enquiryId: { in: enquiryIds } }, select: { id: true } })).map((m) => m.id);
  await prisma.order.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.dealReport.deleteMany({ where: { match: { enquiryId: { in: enquiryIds } } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.spendRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.memberSpendLimit.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.approvalPolicy.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...enquiryIds, ...convos]}) OR payload->>'buyerBusinessId' = ANY(${bizIds}) OR payload->>'businessId' = ANY(${bizIds}) OR payload->>'sellerBusinessId' = ANY(${bizIds})`;
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("input guards", () => {
  it("applyLineAwards rejects a malformed requirement id, an empty award and an unknown quote or line", async () => {
    const t = await team();
    const buyer = { personId: t.owner, businessId: t.businessId };
    const { e, quoteId } = await quoted(buyer);
    const l1 = e.lines[0]!.id;
    await expect(applyLineAwards(buyer, "nope", [{ enquiryLineId: l1, quoteId }])).rejects.toMatchObject({ code: "not_found" });
    await expect(applyLineAwards(buyer, e.id, [])).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/at least one line/) });
    await expect(applyLineAwards(buyer, e.id, [{ enquiryLineId: "bad", quoteId }])).rejects.toMatchObject({ code: "validation" });
    await expect(applyLineAwards(buyer, e.id, [{ enquiryLineId: l1, quoteId: randomUUID() }])).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/Quote not found/) });
    await expect(applyLineAwards(buyer, e.id, [{ enquiryLineId: randomUUID(), quoteId }])).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/does not belong/) });
    await expect(applyLineAwards(buyer, randomUUID(), [{ enquiryLineId: l1, quoteId }])).rejects.toMatchObject({ code: "not_found" });
  });

  it("only accepted leads can be awarded", async () => {
    const t = await team();
    const buyer = { personId: t.owner, businessId: t.businessId };
    const { e, quoteId } = await quoted(buyer);
    await prisma.match.updateMany({ where: { enquiryId: e.id }, data: { status: "declined" } });
    await expect(applyLineAwards(buyer, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }])).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/accepted leads/) });
  });

  it("two quotes of different suppliers cannot be mixed under one supplier, and a quote needs one entry per supplier", async () => {
    const t = await team();
    const buyer = { personId: t.owner, businessId: t.businessId };
    const { e, quoteId } = await quoted(buyer);
    // a second quote from the same supplier on the same conversation makes the first stale; awarding both quotes of one supplier is refused
    const conv = await prisma.conversation.findFirstOrThrow({ where: { match: { enquiryId: e.id } } });
    const s = sellers[0]!;
    const { quoteId: newer } = await sendQuote(s, conv.id, { lines: [{ ordinal: 1, unitPricePaise: 9 }, { ordinal: 2, unitPricePaise: 19 }] });
    await expect(applyLineAwards(buyer, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }, { enquiryLineId: e.lines[1]!.id, quoteId: newer }])).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/one quote per supplier/i) });
  });
});

describe("team members", () => {
  it("a member without the quote.decide capability is refused; a requester can award and the spend is recorded", async () => {
    const t = await team();
    const { e, quoteId } = await quoted({ personId: t.owner, businessId: t.businessId });
    await expect(awardLines(t.viewer, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }])).rejects.toMatchObject({ code: "forbidden" });
    const out = await awardLines(t.requester, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }, { enquiryLineId: e.lines[1]!.id, quoteId }]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.totalPaise).toBe(1000 * 10 + 1000 * 20);
    expect(await getSpentPaise(t.businessId, t.requester.personId)).toBe(out.results[0]!.totalPaise);
  });

  it("an invalid award from a member is a validation error before any approval lookup", async () => {
    const t = await team();
    await expect(awardLines(t.requester, randomUUID(), [])).rejects.toMatchObject({ code: "validation" });
  });

  it("an approval rule that matches the awarded value refuses the direct award", async () => {
    const t = await team();
    await savePolicy(t.businessId, t.owner, { name: "Awards over 100 rupees", action: "quote_accept", minAmountPaise: 10_000, levels: [{ role: "owner" }] });
    const { e, quoteId } = await quoted({ personId: t.owner, businessId: t.businessId });
    // 10 000 paise = 1000 x 10: the first line alone meets the threshold
    await expect(awardLines(t.requester, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }])).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/needs approval/) });
    expect(await prisma.enquiryLineAward.count({ where: { enquiryId: e.id } })).toBe(0);
  });

  it("a monthly spend limit refuses an award that would exceed it, and allows one within it", async () => {
    const t = await team();
    await setSpendLimit({ businessId: t.businessId, actorPersonId: t.owner, personId: t.requester.personId, monthlyCapPaise: 15_000 });
    const { e, quoteId } = await quoted({ personId: t.owner, businessId: t.businessId });
    await expect(awardLines(t.requester, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }, { enquiryLineId: e.lines[1]!.id, quoteId }])).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/needs approval/) });
    const ok = await awardLines(t.requester, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }]);
    expect(ok.results[0]!.totalPaise).toBe(10_000);
    expect(await getSpentPaise(t.businessId, t.requester.personId)).toBe(10_000);
  });
});
