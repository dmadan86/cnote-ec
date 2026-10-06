// Rate contracts: guard, validation and read-path edges (complements rate-contracts.db.test.ts).
import { prisma } from "@cnote/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "rce-media-"));
process.env.PURCHASE_ORDERS_ENABLED = "true";
process.env.RATE_CONTRACTS_ENABLED = "true";

const lib = await import("../src");

type Actor = { personId: string; businessId: string };
const tag = `rce-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let uid = 0;

const gstin = (state: string) => `${state}${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("")}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z5`;
async function party(name: string, isSeller = false): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label, gstin: gstin("29"), isSeller } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}
async function pair() {
  const buyer = await party("buyer");
  const seller = await party("seller", true);
  const address = await prisma.businessAddress.create({ data: { businessId: buyer.businessId, label: "Warehouse", contactName: "Ravi", phone: "9876543210", line1: "12 Industrial Area", city: "Bengaluru", state: "Karnataka", stateCode: "29", pincode: "560058", isDefault: true } });
  return { buyer, seller, addressId: address.id };
}
const today = () => lib.istDate(new Date());
const box = { description: "Corrugated box 12x10", hsn: "4819", unit: "pcs", unitPricePaise: 2500, gstRateBps: 1800, moq: 10, quantityCap: 1000 };
const terms = (over: Partial<import("../src").RcTermsInput> = {}): import("../src").RcTermsInput => ({ validFrom: today(), validTo: lib.addDays(today(), 364), paymentTermsDays: 30, priceBasis: "delivered", items: [box], ...over });

async function draft() {
  const p = await pair();
  const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes 2026-27", terms: terms() });
  return { ...p, id: c.id };
}
async function active(over: Partial<import("../src").RcTermsInput> = {}) {
  const p = await pair();
  const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes 2026-27", terms: terms(over) });
  await lib.sendRateContract(p.buyer, c.id);
  const view = await lib.respondToRateContract(p.seller, c.id, { revision: 1, decision: "accepted" });
  return { ...p, id: c.id, view };
}

afterAll(async () => {
  const contracts = (await prisma.rateContract.findMany({ where: { buyerBusinessId: { in: bizIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.rateContract.deleteMany({ where: { id: { in: contracts } } });
  await prisma.rateContractSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.supplierInvoice.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrderSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.order.deleteMany({ where: { OR: [{ buyerBusinessId: { in: bizIds } }, { matchId: { in: matchIds } }] } });
  const convos = (await prisma.conversation.findMany({ where: { matchId: { in: matchIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.businessAddress.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE payload->>'buyerBusinessId' = ANY(${bizIds}) OR payload->>'businessId' = ANY(${bizIds})`;
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("flag and identifiers", () => {
  it("every write refuses when rate contracts are switched off", async () => {
    const d = await draft();
    try {
      for (const off of ["0", "false", "off"]) {
        process.env.RATE_CONTRACTS_ENABLED = off;
        expect(lib.rateContractsEnabled()).toBe(false);
        await expect(lib.createRateContract(d.buyer, { sellerBusinessId: d.seller.businessId, title: "Boxes", terms: terms() })).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.updateRateContractDraft(d.buyer, d.id, { terms: terms() })).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.sendRateContract(d.buyer, d.id)).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.proposeRateContractRevision(d.buyer, d.id, terms())).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.respondToRateContract(d.seller, d.id, { revision: 1, decision: "accepted" })).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.terminateRateContract(d.buyer, d.id, "reason")).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.startRateContractRenewal(d.buyer, d.id)).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.placeCallOff(d.buyer, d.id, { lines: [] })).rejects.toMatchObject({ code: "forbidden" });
        await expect(lib.createRateContractFromQuote(d.buyer, randomUUID())).rejects.toMatchObject({ code: "forbidden" });
      }
    } finally {
      process.env.RATE_CONTRACTS_ENABLED = "true";
    }
    expect(lib.rateContractsEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("malformed ids are 'not found' everywhere", async () => {
    const d = await draft();
    expect(await lib.getRateContract(d.buyer, "x")).toBeNull();
    await expect(lib.updateRateContractDraft(d.buyer, "x", { terms: terms() })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.sendRateContract(d.buyer, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.proposeRateContractRevision(d.buyer, "x", terms())).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.respondToRateContract(d.buyer, "x", { revision: 1, decision: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.terminateRateContract(d.buyer, "x", "reason")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.startRateContractRenewal(d.buyer, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.placeCallOff(d.buyer, "x", { lines: [] })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.placeCallOff(d.buyer, randomUUID(), { lines: [] })).rejects.toMatchObject({ code: "not_found" });
    expect(await lib.rateContractLinkForOrder(d.buyer, "x")).toBeNull();
    expect(await lib.rateContractLinkForOrder(d.buyer, randomUUID())).toBeNull();
    expect(await lib.suggestFromQuote(d.buyer, "x")).toBeNull();
    expect(await lib.suggestFromQuote(d.buyer, randomUUID())).toBeNull();
    await expect(lib.createRateContractFromQuote(d.buyer, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("drafts", () => {
  it("validates the title, the supplier, item keys and catalogue references", async () => {
    const p = await pair();
    const mk = (over: Record<string, unknown>) => lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes", terms: terms(), ...over } as never);
    await expect(mk({ title: "ab" })).rejects.toMatchObject({ code: "validation" });
    await expect(mk({ title: "t".repeat(121) })).rejects.toMatchObject({ code: "validation" });
    await expect(mk({ title: undefined })).rejects.toMatchObject({ code: "validation" });
    await expect(mk({ sellerBusinessId: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(mk({ sellerBusinessId: randomUUID() })).rejects.toMatchObject({ code: "validation" });
    await expect(mk({ terms: terms({ items: [{ ...box, itemKey: randomUUID() }] }) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/item keys/) });
    await expect(mk({ terms: terms({ items: [{ ...box, listingId: randomUUID() }] }) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/published products/) });
  });

  it("only the buyer edits or sends a draft; the draft must still be in date; unknown items are refused", async () => {
    const d = await draft();
    await expect(lib.updateRateContractDraft(d.seller, d.id, { terms: terms() })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.sendRateContract(d.seller, d.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.updateRateContractDraft(d.buyer, d.id, { terms: terms({ items: [{ ...box, itemKey: randomUUID() }] }) })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/Unknown item/) });
    await expect(lib.updateRateContractDraft(d.buyer, d.id, { title: "x", terms: terms() })).rejects.toMatchObject({ code: "validation" });
    // keeping the same item key on edit is fine, and the title is unchanged when omitted
    const cur = (await lib.getRateContract(d.buyer, d.id))!;
    const key = cur.pending!.items[0]!.itemKey;
    const edited = await lib.updateRateContractDraft(d.buyer, d.id, { terms: terms({ items: [{ ...box, itemKey: key, unitPricePaise: 2600 }] }) });
    expect(edited.title).toBe("Boxes 2026-27");
    expect(edited.pending!.items[0]).toMatchObject({ itemKey: key, unitPricePaise: 2600 });
    await lib.sendRateContract(d.buyer, d.id, new Date(Date.now() + 400 * 86_400_000)).then(
      () => { throw new Error("expected a past end date to be refused"); },
      (e) => expect(e).toMatchObject({ code: "validation", message: expect.stringMatching(/in the past/) }),
    );
    await lib.sendRateContract(d.buyer, d.id);
    await expect(lib.sendRateContract(d.buyer, d.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a buyer can discard an unsent draft; a seller cannot see or terminate it; a terminated draft raises no event", async () => {
    const d = await draft();
    await expect(lib.terminateRateContract(d.seller, d.id, "not yours")).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.terminateRateContract(d.buyer, d.id, "no")).rejects.toMatchObject({ code: "validation" });
    await expect(lib.terminateRateContract(d.buyer, d.id, "r".repeat(301))).rejects.toMatchObject({ code: "validation" });
    await expect(lib.proposeRateContractRevision(d.seller, d.id, terms())).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.proposeRateContractRevision(d.buyer, d.id, terms())).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/Send the contract first/) });
    await expect(lib.respondToRateContract(d.seller, d.id, { revision: 1, decision: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    const t = await lib.terminateRateContract(d.buyer, d.id, "Not needed any more");
    expect(t.status).toBe("terminated");
    await expect(lib.terminateRateContract(d.buyer, d.id, "again please")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already terminated/) });
    await expect(lib.proposeRateContractRevision(d.buyer, d.id, terms())).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/terminated/) });
    await expect(lib.respondToRateContract(d.seller, d.id, { revision: 1, decision: "accepted" })).rejects.toMatchObject({ code: "conflict" });
    const evs = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM domain_events WHERE type = 'RateContractTerminated' AND payload->>'contractId' = ${d.id}`;
    expect(Number(evs[0]!.n)).toBe(0);
  });
});

describe("answering a proposal", () => {
  it("validates the decision and reason, and refuses stale, repeated and own answers", async () => {
    const d = await draft();
    await lib.sendRateContract(d.buyer, d.id);
    const answer = (input: Record<string, unknown>, who = d.seller) => lib.respondToRateContract(who, d.id, input as never);
    await expect(answer({ revision: 1, decision: "maybe" })).rejects.toMatchObject({ code: "validation" });
    await expect(answer({ revision: 1, decision: "rejected" })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/why you are declining/) });
    await expect(answer({ revision: 1, decision: "rejected", reason: "no" })).rejects.toMatchObject({ code: "validation" });
    await expect(answer({ revision: 1, decision: "accepted", reason: "r".repeat(501) })).rejects.toMatchObject({ code: "validation" });
    await expect(answer({ revision: 7, decision: "accepted" })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/newer revision/) });
    const stranger = await party("stranger");
    await expect(answer({ revision: 1, decision: "accepted" }, stranger)).rejects.toMatchObject({ code: "not_found" });
    await answer({ revision: 1, decision: "rejected", reason: "Price too low" });
    await expect(answer({ revision: 1, decision: "accepted" })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already answered/) });
    const view = (await lib.getRateContract(d.buyer, d.id))!;
    expect(view.history[0]).toMatchObject({ revision: 1, state: "declined" });
  });

  it("an accepted revision whose dates have passed cannot be activated", async () => {
    const d = await draft();
    await lib.sendRateContract(d.buyer, d.id);
    await expect(lib.respondToRateContract(d.seller, d.id, { revision: 1, decision: "accepted" }, new Date(Date.now() + 400 * 86_400_000))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already ended/) });
  });
});

describe("amendments to an active contract", () => {
  it("validates against the live terms: unknown items, a moved start date, and a cap below consumption", async () => {
    const a = await active();
    const key = a.view.current!.items[0]!.itemKey;
    await expect(lib.proposeRateContractRevision(a.buyer, a.id, terms({ items: [{ ...box, itemKey: randomUUID() }] }))).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/Unknown item/) });
    await expect(lib.proposeRateContractRevision(a.buyer, a.id, terms({ validFrom: lib.addDays(today(), 1), items: [{ ...box, itemKey: key }] }))).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/start date cannot change/) });

    await lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    await expect(lib.proposeRateContractRevision(a.buyer, a.id, terms({ items: [{ ...box, description: "Other", unit: "kg" }] }))).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/cannot be removed/) });
    await expect(lib.proposeRateContractRevision(a.buyer, a.id, terms({ items: [{ ...box, itemKey: key, unit: "kg" }] }))).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/unit/) });
    await expect(lib.proposeRateContractRevision(a.buyer, a.id, terms({ items: [{ ...box, itemKey: key, quantityCap: 50 }] }))).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/cannot be below the 100/) });
    await expect(lib.proposeRateContractRevision(a.buyer, a.id, terms({ valueCapPaise: 1000, items: [{ ...box, itemKey: key }] }))).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/value cap/) });
    const ok = await lib.proposeRateContractRevision(a.seller, a.id, terms({ items: [{ ...box, itemKey: key, quantityCap: 500, unitPricePaise: 2700 }], changeNote: "Board price" }));
    expect(ok.latestRevision).toBe(2);
    expect(ok.actions.respond).toBe(false);
    expect((await lib.getRateContract(a.buyer, a.id))!.actions.respond).toBe(true);
  });
});

describe("call-off guards", () => {
  it("rejects long idempotency keys, bad dates, a missing or foreign address; only the buyer may call off", async () => {
    const a = await active();
    const key = a.view.current!.items[0]!.itemKey;
    const line = [{ itemKey: key, quantity: 10 }];
    await expect(lib.placeCallOff(a.seller, a.id, { addressId: a.addressId, lines: line })).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: line, idempotencyKey: "k".repeat(101) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: line, expectedDelivery: "garbage" })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: line, expectedDelivery: lib.addDays(today(), -1) })).rejects.toMatchObject({ code: "validation" });
    await expect(lib.placeCallOff(a.buyer, a.id, { lines: line })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/delivery address/) });
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: randomUUID(), lines: line })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/saved addresses/) });
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [] })).rejects.toMatchObject({ code: "validation" });
  });

  it("an expired or ended contract refuses call-offs and offers renewal", async () => {
    const a = await active({ validFrom: lib.addDays(today(), -30), validTo: lib.addDays(today(), 5) });
    const key = a.view.current!.items[0]!.itemKey;
    const later = new Date(Date.now() + 10 * 86_400_000);
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 10 }] }, later)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/ended/) });
    const swept = await lib.sweepRateContracts(later);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    await expect(lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 10 }] })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/expired/) });
    const renewed = await lib.startRateContractRenewal(a.buyer, a.id, later);
    expect(renewed.status).toBe("draft");
    expect(renewed.renewedFromId).toBe(a.id);
  });

  it("a call-off with the purchase order switched off still places the order", async () => {
    const a = await active();
    const key = a.view.current!.items[0]!.itemKey;
    process.env.PURCHASE_ORDERS_ENABLED = "false";
    try {
      const r = await lib.placeCallOff(a.buyer, a.id, { lines: [{ itemKey: key, quantity: 10 }], idempotencyKey: " retry-1 " });
      expect(r).toMatchObject({ purchaseOrder: null, purchaseOrderError: null });
      const again = await lib.placeCallOff(a.buyer, a.id, { lines: [{ itemKey: key, quantity: 10 }], idempotencyKey: "retry-1" });
      expect(again.callOff.id).toBe(r.callOff.id);
      expect(await lib.rateContractLinkForOrder(a.seller, r.orderId)).toMatchObject({ contractId: a.id, callOffNo: 1 });
      expect(await lib.rateContractLinkForOrder(await party("x"), r.orderId)).toBeNull();
    } finally {
      process.env.PURCHASE_ORDERS_ENABLED = "true";
    }
  });

  it("reports a purchase order that could not be issued without undoing the call-off", async () => {
    const a = await active();
    const key = a.view.current!.items[0]!.itemKey;
    // the address belongs to the buyer; remove it between validation and issue is racy, so use a past delivery date accepted by neither check
    const r = await lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 10 }], notes: "n".repeat(1001) });
    expect(r.orderId).toBeTruthy();
    expect(r.purchaseOrder).toBeNull();
    expect(r.purchaseOrderError).toMatch(/under 1000/);
  });
});

describe("listing and lookups", () => {
  it("lists by role and status, hides drafts from sellers, and tolerates a bad cursor", async () => {
    const d = await draft();
    expect((await lib.listRateContracts(d.buyer, { role: "buyer", status: "draft" })).items.map((i) => i.id)).toContain(d.id);
    expect((await lib.listRateContracts(d.seller, { role: "seller", status: "draft" })).items).toEqual([]);
    expect((await lib.listRateContracts(d.seller, { role: "seller" })).items).toEqual([]);
    expect((await lib.listRateContracts(d.buyer, { role: "buyer", cursor: "not-a-uuid", limit: 0 })).items.length).toBe(1);
    expect((await lib.listRateContracts(d.buyer, { role: "buyer", limit: 500 })).nextCursor).toBeNull();
    const a = await active({ valueCapPaise: 1_000_000 });
    const key = a.view.current!.items[0]!.itemKey;
    await lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    const row = (await lib.listRateContracts(a.buyer, { role: "buyer" })).items[0]!;
    expect(row).toMatchObject({ status: "active", valuePercent: 25, needsAnswer: false });
  });

  it("lists counterparties from orders, once, without the buyer itself", async () => {
    const a = await active();
    const key = a.view.current!.items[0]!.itemKey;
    await lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 10 }] });
    await lib.placeCallOff(a.buyer, a.id, { addressId: a.addressId, lines: [{ itemKey: key, quantity: 10 }] });
    const cps = await lib.listContractCounterparties(a.buyer);
    expect(cps.map((c) => c.businessId)).toEqual([a.seller.businessId]);
    expect(await lib.listContractCounterparties(await party("lonely"))).toEqual([]);
  });

  it("a quote converts to a draft only for the buyer of an accepted lead, with the price excluding GST when included", async () => {
    const p = await pair();
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: p.buyer.businessId, buyerPersonId: p.buyer.personId, title: "Corrugated boxes", requirement: "Need boxes" } });
    enquiryIds.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: p.seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    matchIds.push(m.id);
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: p.seller.businessId, pricePaise: 11_800n, quantity: 100, unit: "pcs", paymentTerms: "net_15", gstIncluded: true, moq: 50, deliveryTerms: "ex_works" } });
    const s = (await lib.suggestFromQuote(p.buyer, q.id))!;
    expect(s.terms).toMatchObject({ paymentTermsDays: 15, priceBasis: "ex_works", items: [{ unitPricePaise: 10_000, moq: 50, unit: "pcs" }] });
    expect(await lib.suggestFromQuote(p.seller, q.id)).toBeNull();
    const view = await lib.createRateContractFromQuote(p.buyer, q.id, { title: "Boxes by quote" });
    expect(view).toMatchObject({ title: "Boxes by quote", sourceQuoteId: q.id });
    await prisma.match.update({ where: { id: m.id }, data: { status: "declined" } });
    expect(await lib.suggestFromQuote(p.buyer, q.id)).toBeNull();
  });
});

describe("renewal guards", () => {
  it("only the buyer of an active or expired contract can renew", async () => {
    const d = await draft();
    await expect(lib.startRateContractRenewal(d.seller, d.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(lib.startRateContractRenewal(d.buyer, d.id)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/active or expired/) });
    await expect(lib.startRateContractRenewal(d.buyer, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
});
