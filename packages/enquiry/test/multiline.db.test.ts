// Multi-line RFQ end to end: lines, per-line quotes, comparison matrix, per-line awards -> one order per supplier. ADR-002, ADR-007.
import { prisma } from "@cnote/db";
import { grantCredits } from "@cnote/billing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  candidates: [] as { sellerBusinessId: string; listingId: string; similarity: number }[],
  profiles: new Map<string, unknown>(),
  intentInputs: [] as { requirement: string }[],
  moderated: [] as string[],
  embedded: [] as string[],
}));

vi.mock("@cnote/ai", () => ({
  moderate: async (input: { text: string }) => {
    state.moderated.push(input.text);
    return { verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false };
  },
  embed: async (texts: string[]) => {
    state.embedded.push(...texts);
    return { vectors: [Array.from({ length: 256 }, (_, i) => (i % 5) / 5)], version: "test" };
  },
  scoreIntent: async (input: { requirement: string }) => {
    state.intentInputs.push(input);
    return { score: 80, reasons: ["Specific quantity"], decisionId: "d", confidence: 0.9, needsReview: false };
  },
}));
// this suite posts many requirements as one buyer; the posting limit has its own tests
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => true }));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async (slug: string) => (slug === "fasteners" ? { id: "11111111-1111-4111-8111-111111111111", slug, name: "Fasteners", prohibited: false, leadCap: 3 } : slug === "banned" ? { id: "22222222-2222-4222-8222-222222222222", slug, name: "Banned", prohibited: true, leadCap: 3 } : null),
  listCategories: async () => [{ id: "11111111-1111-4111-8111-111111111111", slug: "fasteners", name: "Fasteners", prohibited: false, leadCap: 3 }],
  getListing: async () => null,
  getPublicListing: async () => null,
  findSellerCandidates: async (o: { excludeSellerIds?: string[] }) => state.candidates.filter((c) => !o.excludeSellerIds?.includes(c.sellerBusinessId)),
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => state.profiles.has(i)).map((i) => [i, state.profiles.get(i)])),
  hasConsent: async () => true,
  getPersonContact: async () => ({ phone: "+919999900000" }),
  getMemberRole: async () => null, // fixtures are not team members: approvals/roles do not apply (docs/design/buyer-approvals.md)
}));

import {
  acceptLead, awardLines, createEnquiry, decideQuote, getAwardedLines, getBuyerEnquiry, getConversation, getQuoteComparison, listAwardedLines, listSellerLeads, sendQuote,
} from "../src";

const tag = `ml-test-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
let buyer: { personId: string; businessId: string };
let outsider: { personId: string; businessId: string };
const sellers: { personId: string; businessId: string }[] = [];

async function party(name: string, tier = 1) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, city: "Pune" } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  personIds.push(p.id); bizIds.push(b.id);
  state.profiles.set(b.id, { businessId: b.id, name: `${tag}-${name}`, city: "Pune", state: "MH", pincode: "411001", verificationTier: tier, trustScore: 60 + tier, badgeActive: tier >= 1, languages: ["en"] });
  return { personId: p.id, businessId: b.id };
}

beforeAll(async () => {
  buyer = await party("buyer", 1);
  outsider = await party("outsider", 1);
  for (const tier of [1, 2, 3]) sellers.push(await party(`s${tier}`, tier));
  state.candidates = sellers.map((s, i) => ({ sellerBusinessId: s.businessId, listingId: randomUUID(), similarity: 0.9 - i * 0.05 }));
  for (const s of sellers) await grantCredits(s.businessId, 40, "test", { refType: "test", refId: "g" });
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
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...enquiryIds, ...convos]}) OR payload->>'buyerBusinessId' = ANY(${bizIds}) OR payload->>'businessId' = ANY(${bizIds}) OR payload->>'sellerBusinessId' = ANY(${bizIds})`;
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

const BOM = [
  { itemName: "M8 hex bolt", spec: "SS304, 40 mm", quantity: 500, unit: "pcs", hsn: "73181500", categorySlug: "fasteners", targetPricePaise: 1200 },
  { itemName: "M8 nut", quantity: 500, unit: "pcs" },
  { itemName: "Flat washer M8", spec: "zinc plated", quantity: 1000, unit: "pcs" },
];

async function postBom(extra: Record<string, unknown> = {}) {
  const e = await createEnquiry(buyer, { title: "Fasteners for line 4", requirement: "Monthly fasteners order for assembly line four", lines: BOM, ...extra }, { buyerPhoneVerified: true });
  enquiryIds.push(e.id);
  return e;
}

/** posts a 3-line RFQ and has the first two sellers accept the lead */
async function twoSellers() {
  const e = await postBom();
  const bySeller = new Map(sellers.map((s) => [s.businessId, s]));
  const acc = [];
  for (const m of e.matches.slice(0, 2)) {
    const seller = bySeller.get(m.sellerBusinessId)!;
    acc.push({ seller, lead: await acceptLead(seller, m.id) });
  }
  return { e, a: acc[0]!, b: acc[1]! };
}

describe("creating a multi-line RFQ", () => {
  it("stores ordered lines, mirrors line 1 on the enquiry and feeds every line to the AI capabilities", async () => {
    state.intentInputs.length = 0; state.moderated.length = 0; state.embedded.length = 0;
    const e = await postBom();
    expect(e.lines.map((l) => [l.ordinal, l.itemName, l.quantity, l.unit])).toEqual([[1, "M8 hex bolt", 500, "pcs"], [2, "M8 nut", 500, "pcs"], [3, "Flat washer M8", 1000, "pcs"]]);
    expect(e.lines[0]).toMatchObject({ hsn: "73181500", targetPricePaise: 1200, category: { slug: "fasteners" }, spec: "SS304, 40 mm" });
    expect(e).toMatchObject({ quantity: 500, quantityUnit: "pcs", targetPricePaise: 1200 });
    expect(e.matches).toHaveLength(3);
    expect(state.intentInputs[0]!.requirement).toContain("Flat washer M8 x 1000 pcs");
    expect(state.moderated[0]).toContain("Flat washer M8");
    expect(state.embedded[0]).toContain("M8 nut x 500 pcs");
    const [ev] = await prisma.$queryRaw<{ version: number; payload: Record<string, unknown> }[]>`SELECT version, payload FROM domain_events WHERE type = 'EnquiryCreated' AND aggregate_id = ${e.id}`;
    expect(ev).toMatchObject({ version: 3, payload: { lineCount: 3 } });
  });

  it("derives the title and description when only lines are sent (API shape)", async () => {
    const e = await createEnquiry(buyer, { lines: [{ itemName: "Copper wire 2.5 sqmm", quantity: 10, unit: "coil" }, { itemName: "MCB 16A", quantity: 40, unit: "pcs" }] });
    enquiryIds.push(e.id);
    expect(e.title).toBe("Copper wire 2.5 sqmm and 1 more item");
    expect(e.requirement).toContain("Bill of materials with 2 line items");
  });

  it("a single-field enquiry gets exactly one line made from its fields, and stays quotable the old way", async () => {
    const e = await createEnquiry(buyer, { title: "CNC machined brackets", requirement: "Need 200 CNC machined aluminium brackets", quantity: 200, quantityUnit: "pcs" });
    enquiryIds.push(e.id);
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0]).toMatchObject({ ordinal: 1, itemName: "CNC machined brackets", quantity: 200, unit: "pcs" });
    const m = e.matches[0]!;
    const seller = sellers.find((s) => s.businessId === m.sellerBusinessId)!;
    const lead = await acceptLead(seller, m.id);
    await sendQuote(seller, lead.conversationId!, { pricePaise: 5000, quantity: 200, unit: "pcs" });
    const cmp = (await getQuoteComparison(buyer, e.id))!;
    expect(cmp.rows[0]).toMatchObject({ quantityBasis: "requested", coverage: null, totalPaise: 1_000_000 });
    expect(cmp.rows[0]!.quote.lineTotals).toBeNull();
    expect(cmp.lines).toHaveLength(1);
  });

  it("rejects 0 lines, 51 lines, bad lines, unknown and prohibited categories", async () => {
    await expect(createEnquiry(buyer, { title: "Valid title", requirement: "Valid requirement text", lines: [] })).rejects.toThrow(/at least one line/i);
    const many = Array.from({ length: 51 }, (_, i) => ({ itemName: `i${i}`, quantity: 1, unit: "pcs" }));
    await expect(postBomWith(many)).rejects.toThrow(/up to 50/);
    await expect(postBomWith([{ itemName: "x", quantity: -1, unit: "pcs" }])).rejects.toThrow();
    await expect(postBomWith([{ itemName: "x", quantity: 1, unit: "pcs", categorySlug: "nope" }])).rejects.toThrow(/Unknown category/);
    await expect(postBomWith([{ itemName: "x", quantity: 1, unit: "pcs", categorySlug: "banned" }])).rejects.toThrow(/not allowed/);
  });
  const postBomWith = (lines: unknown[]) => createEnquiry(buyer, { title: "Valid title", requirement: "Valid requirement text", lines: lines as never });
});

describe("per-line quotes", () => {
  it("computes totals server-side, mirrors the first priced line, allows partial quotes, emits QuoteSent v2", async () => {
    const { e, a } = await twoSellers();
    const [l1, l2, l3] = e.lines;
    const { quoteId } = await sendQuote(a.seller, a.lead.conversationId!, {
      gstIncluded: false,
      lines: [
        { enquiryLineId: l1!.id, unitPricePaise: 1100, gstRatePct: 18, leadTimeDays: 7 },
        { enquiryLineId: l2!.id, cantSupply: true, notes: "out of stock" },
        { ordinal: 3, unitPricePaise: 90, gstRatePct: 12, notes: "bulk rate" },
      ],
      // a client-supplied total or price is ignored: lines decide
      pricePaise: 1,
    });
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { lines: true } });
    expect(q.lines).toHaveLength(3);
    // 500 x 1100 = 550000 (+18% = 99000) ; 1000 x 90 = 90000 (+12% = 10800)
    expect([q.lineSubtotalPaise, q.lineGstPaise, q.lineTotalPaise, q.quotedLineCount]).toEqual([640000n, 109800n, 749800n, 2]);
    expect([q.pricePaise, q.quantity, q.unit]).toEqual([1100n, 500, "pcs"]);
    const cant = q.lines.find((l) => l.enquiryLineId === l2!.id)!;
    expect(cant).toMatchObject({ cantSupply: true, unitPricePaise: null, lineTotalPaise: null });
    const [ev] = await prisma.$queryRaw<{ version: number; payload: Record<string, unknown> }[]>`SELECT version, payload FROM domain_events WHERE type = 'QuoteSent' AND aggregate_id = ${a.lead.conversationId!}`;
    expect(ev).toMatchObject({ version: 2, payload: { lineCount: 2, totalPaise: 749800 } });
    const convo = (await getConversation(a.seller, a.lead.conversationId!))!;
    expect(convo.quotes[0]!.lines).toHaveLength(3);
    expect(convo.quotes[0]!.lineTotals).toMatchObject({ totalPaise: 749800, quotedLineCount: 2 });
    void l3;
  });

  it("requires per-line prices on a multi-line RFQ and rejects foreign, duplicate and fully unpriced lines", async () => {
    const { e, a } = await twoSellers();
    const convo = a.lead.conversationId!;
    await expect(sendQuote(a.seller, convo, { pricePaise: 100, quantity: 1, unit: "pcs" })).rejects.toThrow(/3 lines/);
    await expect(sendQuote(a.seller, convo, { lines: [{ enquiryLineId: randomUUID(), unitPricePaise: 5 }] })).rejects.toThrow(/does not belong/);
    await expect(sendQuote(a.seller, convo, { lines: [{ ordinal: 1, unitPricePaise: 5 }, { ordinal: 1, unitPricePaise: 6 }] })).rejects.toThrow(/twice/);
    await expect(sendQuote(a.seller, convo, { lines: [{ ordinal: 1, cantSupply: true }] })).rejects.toThrow(/at least one line/);
    // a line from another requirement
    const other = await postBom();
    await expect(sendQuote(a.seller, convo, { lines: [{ enquiryLineId: other.lines[0]!.id, unitPricePaise: 5 }] })).rejects.toThrow(/does not belong/);
    void e;
  });
});

describe("comparison matrix and per-line award", () => {
  it("marks the lowest per line, then awards different lines to different suppliers: one order each, only awarded lines", async () => {
    const { e, a, b } = await twoSellers();
    const [l1, l2, l3] = e.lines as [typeof e.lines[0], typeof e.lines[0], typeof e.lines[0]];
    const { quoteId: qa } = await sendQuote(a.seller, a.lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 1000 }, { ordinal: 2, unitPricePaise: 300 }, { ordinal: 3, unitPricePaise: 80 }] });
    const { quoteId: qb } = await sendQuote(b.seller, b.lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 1100 }, { ordinal: 2, unitPricePaise: 250 }], gstIncluded: true });

    const cmp = (await getQuoteComparison(buyer, e.id))!;
    expect(cmp.lines).toHaveLength(3);
    expect(cmp.lowestByLine[l1.id]).toEqual([qa]);
    expect(cmp.lowestByLine[l2.id]).toEqual([qb]);
    expect(cmp.lowestByLine[l3.id]).toEqual([qa]); // supplier B skipped line 3 (partial quote)
    const rb = cmp.rows.find((r) => r.quote.id === qb)!;
    expect(rb).toMatchObject({ quantityBasis: "lines", coverage: { quoted: 2, of: 3 }, totalPaise: 1100 * 500 + 250 * 500 });
    expect(cmp.awards).toEqual([]);

    // outsiders can't award, can't see
    await expect(awardLines(outsider, e.id, [{ enquiryLineId: l1.id, quoteId: qa }])).rejects.toThrow(/not found/i);
    expect(await getQuoteComparison(outsider, e.id)).toBeNull();
    // cannot award a line the quote did not price
    await expect(awardLines(buyer, e.id, [{ enquiryLineId: l3.id, quoteId: qb }])).rejects.toThrow(/not priced/);
    // one quote per supplier, no duplicate lines
    await expect(awardLines(buyer, e.id, [{ enquiryLineId: l1.id, quoteId: qa }, { enquiryLineId: l1.id, quoteId: qb }])).rejects.toThrow(/once/);
    // a quote from another requirement
    const other = await postBom();
    await expect(awardLines(buyer, other.id, [{ enquiryLineId: other.lines[0]!.id, quoteId: qa }])).rejects.toThrow(/not found/i);

    const { results } = await awardLines(buyer, e.id, [
      { enquiryLineId: l1.id, quoteId: qa }, { enquiryLineId: l3.id, quoteId: qa }, { enquiryLineId: l2.id, quoteId: qb },
    ]);
    expect(results).toHaveLength(2);
    const ra = results.find((r) => r.quoteId === qa)!;
    const rbo = results.find((r) => r.quoteId === qb)!;
    expect(ra.totalPaise).toBe(1000 * 500 + 80 * 1000);
    expect(rbo.totalPaise).toBe(250 * 500);
    expect(ra.orderId).not.toBe(rbo.orderId);

    const orders = await prisma.order.findMany({ where: { enquiryId: e.id } });
    expect(orders).toHaveLength(2);
    const oa = orders.find((o) => o.id === ra.orderId)!;
    expect(oa).toMatchObject({ sellerBusinessId: a.seller.businessId, quoteId: qa, quantity: null, unit: null, pricePaise: null, totalPaise: BigInt(ra.totalPaise) });

    // snapshots for a purchase order
    const aw = await getAwardedLines(ra.orderId);
    expect(aw.map((x) => [x.ordinal, x.itemName, x.quantity, x.unit, x.unitPricePaise, x.lineTotalPaise])).toEqual([[1, "M8 hex bolt", 500, "pcs", 1000, 500000], [3, "Flat washer M8", 1000, "pcs", 80, 80000]]);
    expect(aw[0]).toMatchObject({ hsn: "73181500", spec: "SS304, 40 mm", sellerBusinessId: a.seller.businessId, orderId: ra.orderId, quoteId: qa });
    const awb = await getAwardedLines(rbo.orderId);
    expect(awb).toHaveLength(1);
    expect(awb[0]).toMatchObject({ gstIncluded: true, lineTotalPaise: 125000 });
    expect(await getAwardedLines(randomUUID())).toEqual([]);
    expect(await getAwardedLines("nope")).toEqual([]);
    expect((await listAwardedLines(buyer, e.id)).map((x) => x.ordinal)).toEqual([1, 2, 3]);
    expect(await listAwardedLines(outsider, e.id)).toEqual([]);

    // events: one LinesAwarded per supplier, the deal reports are buyer-confirmed
    const evs = await prisma.$queryRaw<{ version: number; payload: Record<string, unknown> }[]>`SELECT version, payload FROM domain_events WHERE type = 'LinesAwarded' AND payload->>'enquiryId' = ${e.id}`;
    expect(evs).toHaveLength(2);
    expect(evs.every((x) => x.version === 1)).toBe(true);
    expect((await prisma.dealReport.findMany({ where: { match: { enquiryId: e.id } } })).every((d) => d.outcome === "won" && d.reportedByBusinessId === buyer.businessId)).toBe(true);

    // the matrix now shows who got what; a line cannot be awarded twice; a supplier with an order takes no more lines
    const after = (await getQuoteComparison(buyer, e.id))!;
    expect(after.awards.map((x) => x.enquiryLineId).sort()).toEqual([l1.id, l2.id, l3.id].sort());
    await expect(awardLines(buyer, e.id, [{ enquiryLineId: l1.id, quoteId: qb }])).rejects.toThrow(/already been awarded/);
    expect((await getBuyerEnquiry(buyer.businessId, e.id))!.lines).toHaveLength(3);
  });

  it("a supplier that already has an order takes no further lines", async () => {
    const { e, a } = await twoSellers();
    const { quoteId } = await sendQuote(a.seller, a.lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 10 }, { ordinal: 2, unitPricePaise: 20 }, { ordinal: 3, unitPricePaise: 30 }] });
    await awardLines(buyer, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId }]);
    await expect(awardLines(buyer, e.id, [{ enquiryLineId: e.lines[1]!.id, quoteId }])).rejects.toThrow(/already has an order/);
  });

  it("only the latest quote of a supplier can be awarded", async () => {
    const { e, a } = await twoSellers();
    const { quoteId: old } = await sendQuote(a.seller, a.lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 10 }] });
    await sendQuote(a.seller, a.lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 9 }] });
    await expect(awardLines(buyer, e.id, [{ enquiryLineId: e.lines[0]!.id, quoteId: old }])).rejects.toThrow(/replaced/);
  });

  it("accepting a per-line quote awards every priced line it still holds; declining records a loss", async () => {
    const { e, a, b } = await twoSellers();
    const { quoteId: qa } = await sendQuote(a.seller, a.lead.conversationId!, { lines: [{ ordinal: 1, unitPricePaise: 10 }, { ordinal: 3, unitPricePaise: 30 }] });
    const { quoteId: qb } = await sendQuote(b.seller, b.lead.conversationId!, { lines: [{ ordinal: 2, unitPricePaise: 20 }] });
    await decideQuote(buyer, qa, "accept");
    const awards = await prisma.enquiryLineAward.findMany({ where: { enquiryId: e.id }, orderBy: { ordinal: "asc" } });
    expect(awards.map((x) => x.ordinal)).toEqual([1, 3]);
    await decideQuote(buyer, qb, "decline");
    expect((await prisma.dealReport.findMany({ where: { matchId: b.lead.matchId } })).map((d) => d.outcome)).toEqual(["lost"]);
    await expect(decideQuote(buyer, qa, "accept")).rejects.toThrow(/already been awarded/);
  });
});

describe("seller lead view", () => {
  it("shows the lines to a matched seller", async () => {
    const e = await postBom();
    const m = e.matches[0]!;
    const lead = (await listSellerLeads(m.sellerBusinessId)).find((l) => l.enquiry.id === e.id)!;
    expect(lead.enquiry.lines.map((l) => l.itemName)).toEqual(["M8 hex bolt", "M8 nut", "Flat washer M8"]);
  });
});
