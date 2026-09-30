import { prisma } from "@cnote/db";
import { grantCredits, getBalance } from "@cnote/billing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ candidates: [] as { sellerBusinessId: string; listingId: string; similarity: number }[], profiles: new Map<string, unknown>() }));

vi.mock("@cnote/ai", () => ({
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false }),
  embed: async () => ({ vectors: [Array.from({ length: 256 }, (_, i) => (i % 7) / 7)], version: "test" }),
  scoreIntent: async () => ({ score: 82, reasons: ["Specific quantity"], decisionId: "d", confidence: 0.9, needsReview: false }),
}));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  listCategories: async () => [],
  getListing: async () => null,
  getPublicListing: async () => null,
  findSellerCandidates: async (o: { excludeSellerIds?: string[] }) => state.candidates.filter((c) => !o.excludeSellerIds?.includes(c.sellerBusinessId)),
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => state.profiles.has(i)).map((i) => [i, state.profiles.get(i)])),
  hasConsent: async () => true,
  getPersonContact: async () => ({ phone: "+919999900000" }),
}));

import { acceptLead, createEnquiry, declineLead, getConversation, listSellerLeads, reportBuyerProblem, sendMessage, sendQuote, reportDeal, expireOverdueOffers } from "../src";
import { setReachabilityDispatchMode } from "../src/reachability";
setReachabilityDispatchMode("inline"); // the worker would deliver; here we deliver in-process

const tag = `enq-test-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
let buyer: { personId: string; businessId: string };
const sellers: { personId: string; businessId: string }[] = [];

async function party(name: string) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, city: "Pune" } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  personIds.push(p.id); bizIds.push(b.id);
  state.profiles.set(b.id, { businessId: b.id, name: `${tag}-${name}`, city: "Pune", state: "MH", pincode: "411001", verificationTier: 1, trustScore: 60, badgeActive: true, languages: ["en"] });
  return { personId: p.id, businessId: b.id };
}

beforeAll(async () => {
  buyer = await party("buyer");
  for (let i = 0; i < 5; i++) sellers.push(await party(`s${i}`));
  state.candidates = sellers.map((s, i) => ({ sellerBusinessId: s.businessId, listingId: randomUUID(), similarity: 0.9 - i * 0.05 }));
  // sellers 0..3 have credits, seller 1 has none
  for (const i of [0, 2, 3, 4]) await grantCredits(sellers[i]!.businessId, 3, "test", { refType: "test", refId: "g" });
});

afterAll(async () => {
  const ids = [...enquiryIds, ...bizIds];
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.dealReport.deleteMany({ where: { match: { enquiryId: { in: enquiryIds } } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...ids, ...convos]}) OR payload->>'businessId' = ANY(${bizIds})`;
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

const post = async (title: string) => {
  const e = await createEnquiry(buyer, { title, requirement: "Need 500 units of corrugated boxes, 3 ply, delivery in Pune", quantity: 500, quantityUnit: "pcs" }, { buyerPhoneVerified: true });
  enquiryIds.push(e.id);
  return e;
};

describe("enquiry → match → accept flow", () => {
  it("matches top-3, accepts (consumes a credit), cascades on decline, refunds on report", async () => {
    const e = await post("Corrugated boxes 3 ply");
    expect(e.status).toBe("matched");
    expect(e.intentScore).toBe(82);
    expect(e.matches.map((m) => m.rank)).toEqual([1, 2, 3]);
    expect(e.matches.every((m) => m.of === 3 && m.status === "offered")).toBe(true);
    const offered = e.matches.map((m) => m.sellerBusinessId);
    expect(offered).not.toContain(buyer.businessId);

    // buyer identity hidden before accept
    const first = e.matches[0]!;
    const seller = sellers.find((s) => s.businessId === first.sellerBusinessId)!;
    const before = (await listSellerLeads(seller.businessId))[0]!;
    expect(before.buyer.phone).toBeNull();
    expect(before.buyer.businessName).toMatch(/hidden/i);

    // accept: credit consumed, conversation opened, contact revealed with consent
    const balBefore = await getBalance(seller.businessId);
    const lead = await acceptLead(seller, first.id);
    expect(lead.status).toBe("accepted");
    expect(lead.conversationId).toBeTruthy();
    expect(lead.buyer.phone).toBe("+919999900000");
    expect(await getBalance(seller.businessId)).toBe(balBefore - 1);
    await acceptLead(seller, first.id); // idempotent: no second charge
    expect(await getBalance(seller.businessId)).toBe(balBefore - 1);

    // decline slot 2 → cascades to the 4th-ranked seller, rank slot preserved
    const second = e.matches[1]!;
    await declineLead(sellers.find((s) => s.businessId === second.sellerBusinessId)!, second.id, "not my range");
    const after = await prisma.match.findMany({ where: { enquiryId: e.id }, orderBy: { rank: "asc" } });
    const active = after.filter((m) => m.status === "offered" || m.status === "accepted");
    expect(active).toHaveLength(3);
    expect(active.map((m) => m.rank)).toEqual([1, 2, 3]);
    expect(after).toHaveLength(4);
    expect(offered).not.toContain(after.find((m) => m.status === "offered" && m.rank === 2)!.sellerBusinessId);

    // messaging
    await sendMessage(buyer, lead.conversationId!, "Can you ship to Pune this week?");
    await sendQuote(seller, lead.conversationId!, { pricePaise: 1250, quantity: 500, unit: "pcs", leadTimeDays: 5 });
    await expect(sendQuote(buyer, lead.conversationId!, { pricePaise: 1, quantity: 1, unit: "pcs" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendMessage(sellers[4]!.businessId === seller.businessId ? sellers[3]! : sellers[4]!, lead.conversationId!, "hi")).rejects.toMatchObject({ code: "not_found" });
    const convo = (await getConversation(buyer, lead.conversationId!))!;
    expect(convo.messages).toHaveLength(1);
    expect(convo.quotes[0]!.pricePaise).toBe(1250);
    await reportDeal(buyer, convo.matchId, "won", 625000);
    expect((await getConversation(seller, convo.id))!.dealReported).toBe("won");

    // refund: unreachable → credit back, idempotent
    await reportBuyerProblem(seller, first.id, "buyer_unreachable");
    await reportBuyerProblem(seller, first.id, "buyer_unreachable");
    expect(await getBalance(seller.businessId)).toBe(balBefore);
  });

  it("insufficient credits rolls back the accept", async () => {
    const e = await post("Kraft paper rolls 100gsm");
    const m = e.matches.find((x) => x.sellerBusinessId === sellers[1]!.businessId);
    // seller[1] (no credits) may not be in top 3 of this run; force by offering directly
    const target = m ?? (await (async () => {
      const row = await prisma.match.findFirst({ where: { enquiryId: e.id } });
      await prisma.match.update({ where: { id: row!.id }, data: { sellerBusinessId: sellers[1]!.businessId } });
      return { id: row!.id };
    })());
    await expect(acceptLead(sellers[1]!, target.id)).rejects.toMatchObject({ code: "insufficient_credits" });
    const row = await prisma.match.findUnique({ where: { id: target.id }, include: { conversation: true } });
    expect(row!.status).toBe("offered");
    expect(row!.conversation).toBeNull();
  });

  it("expired offers cascade", async () => {
    const e = await post("Bubble wrap rolls");
    await prisma.match.updateMany({ where: { enquiryId: e.id, rank: 1 }, data: { respondBy: new Date(Date.now() - 1000) } });
    expect(await expireOverdueOffers()).toBeGreaterThanOrEqual(1);
    const rows = await prisma.match.findMany({ where: { enquiryId: e.id } });
    expect(rows.filter((r) => r.status === "expired")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "offered")).toHaveLength(3);
  });

  it("two sellers flagging fake rejects the enquiry and refunds all accepted matches", async () => {
    const e = await post("Packing tape 48mm");
    const ms = await prisma.match.findMany({ where: { enquiryId: e.id }, orderBy: { rank: "asc" } });
    const actors = ms.map((m) => sellers.find((s) => s.businessId === m.sellerBusinessId)!);
    const bal = await Promise.all(actors.map((a) => getBalance(a.businessId)));
    for (let i = 0; i < 3; i++) if (bal[i]! > 0) await acceptLead(actors[i]!, ms[i]!.id);
    const accepted = actors.filter((_, i) => bal[i]! > 0);
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    await reportBuyerProblem(accepted[0]!, ms[actors.indexOf(accepted[0]!)]!.id, "buyer_fake");
    expect((await prisma.enquiry.findUnique({ where: { id: e.id } }))!.status).toBe("matched");
    await reportBuyerProblem(accepted[1]!, ms[actors.indexOf(accepted[1]!)]!.id, "buyer_fake");
    expect((await prisma.enquiry.findUnique({ where: { id: e.id } }))!.status).toBe("rejected");
    const rows = await prisma.match.findMany({ where: { enquiryId: e.id } });
    expect(rows.filter((r) => r.status === "accepted")).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(await getBalance(actors[i]!.businessId)).toBe(bal[i]!);
  });
});

