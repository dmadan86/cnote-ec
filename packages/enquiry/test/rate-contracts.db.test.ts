// Rate contracts against the real database: negotiation (draft -> proposed -> active), versioned amendments, call-off orders with locked
// prices and cap enforcement, 80% / 100% warnings, expiry reminders, explicit renewal, privacy (DPDP) and tenancy (docs/design/rate-contracts.md).
import { prisma } from "@cnote/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "rc-media-"));
process.env.PURCHASE_ORDERS_ENABLED = "true";
process.env.RATE_CONTRACTS_ENABLED = "true";

const lib = await import("../src");
const { exportPersonalData } = await import("../src/privacy");

type Actor = { personId: string; businessId: string };
const tag = `rc-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const matchIds: string[] = [];
let uid = 0;

const gstin = (state: string) => `${state}${Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("")}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z5`;

async function party(name: string, extra: { isSeller?: boolean } = {}): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label, gstin: gstin("29"), isSeller: extra.isSeller ?? false } });
  personIds.push(p.id); bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

async function coPersonOf(a: Actor, name: string): Promise<Actor> {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}-${++uid}` } });
  personIds.push(p.id);
  return { personId: p.id, businessId: a.businessId };
}

async function pair() {
  const buyer = await party("buyer");
  const seller = await party("seller", { isSeller: true });
  const address = await prisma.businessAddress.create({ data: { businessId: buyer.businessId, label: "Warehouse", contactName: "Ravi", phone: "9876543210", line1: "12 Industrial Area", city: "Bengaluru", state: "Karnataka", stateCode: "29", pincode: "560058", isDefault: true } });
  return { buyer, seller, addressId: address.id };
}

const today = () => lib.istDate(new Date());
const addDays = lib.addDays;

const box = { description: "Corrugated box 12x10", hsn: "4819", unit: "pcs", unitPricePaise: 2500, gstRateBps: 1800, moq: 100, quantityCap: 1000 };
const wire = { description: "Copper wire 2.5mm", unit: "kg", unitPricePaise: 80000, gstRateBps: 1800, variationKind: "indexed" as const, variationCapBps: 500, variationNote: "LME copper monthly average" };

function terms(over: Partial<import("../src").RcTermsInput> = {}): import("../src").RcTermsInput {
  return { validFrom: today(), validTo: addDays(today(), 364), paymentTermsDays: 30, priceBasis: "delivered", items: [box], ...over };
}

/** A contract both parties accepted. */
async function activeContract(over: Partial<import("../src").RcTermsInput> = {}) {
  const p = await pair();
  const draft = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes 2026-27", terms: terms(over) });
  await lib.sendRateContract(p.buyer, draft.id);
  const active = await lib.respondToRateContract(p.seller, draft.id, { revision: 1, decision: "accepted" });
  return { ...p, id: draft.id, view: active };
}

const events = (type: string, contractId: string) =>
  prisma.$queryRaw<{ payload: Record<string, unknown>; version: number }[]>`SELECT payload, version FROM domain_events WHERE type = ${type} AND payload->>'contractId' = ${contractId} ORDER BY id`;

afterAll(async () => {
  const contracts = (await prisma.rateContract.findMany({ where: { buyerBusinessId: { in: bizIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.rateContract.deleteMany({ where: { id: { in: contracts } } });
  await prisma.rateContractSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.supplierInvoice.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.purchaseOrderSequence.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
  await prisma.order.deleteMany({ where: { buyerBusinessId: { in: bizIds } } });
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

describe("negotiation: draft -> proposed -> active", () => {
  it("a draft is private to the buyer, numbered per buyer and financial year, and starts with no acceptance", async () => {
    const p = await pair();
    const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes 2026-27", terms: terms() });
    expect(c).toMatchObject({ status: "draft", role: "buyer", latestRevision: 1, activeRevision: null, current: null });
    expect(c.number).toMatch(/^RC\/\d{2}-\d{2}\/000001$/);
    expect(c.pending!.answers).toMatchObject({ buyer: "pending", seller: "pending" });
    expect(c.actions).toMatchObject({ edit: true, send: true, respond: false, callOff: false });
    expect(await lib.getRateContract(p.seller, c.id)).toBeNull();
    expect((await lib.listRateContracts(p.seller, { role: "seller" })).items).toHaveLength(0);
    const second = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Wire", terms: terms() });
    expect(second.number).toMatch(/000002$/);
    expect(await events("RateContractProposed", c.id)).toHaveLength(0);
  });

  it("the buyer can edit the draft in place; sending makes it a proposal the seller sees, with a versioned event", async () => {
    const p = await pair();
    const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes", terms: terms() });
    const edited = await lib.updateRateContractDraft(p.buyer, c.id, { title: "Boxes and wire", terms: terms({ items: [box, wire] }) });
    expect(edited.title).toBe("Boxes and wire");
    expect(edited.pending!.items.map((i) => i.description)).toEqual([box.description, wire.description]);
    const sent = await lib.sendRateContract(p.buyer, c.id);
    expect(sent.status).toBe("proposed");
    expect(sent.pending!.answers).toMatchObject({ buyer: "accepted", seller: "pending" });
    await expect(lib.updateRateContractDraft(p.buyer, c.id, { terms: terms() })).rejects.toThrow(/already sent/);
    const seen = await lib.getRateContract(p.seller, c.id);
    expect(seen).toMatchObject({ status: "proposed", role: "seller", actions: { respond: true, callOff: false, edit: false } });
    expect((await lib.listRateContracts(p.seller, { role: "seller" })).items[0]).toMatchObject({ id: c.id, needsAnswer: true });
    const ev = await events("RateContractProposed", c.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ version: 1, payload: { revision: 1, amendment: false, buyerBusinessId: p.buyer.businessId, sellerBusinessId: p.seller.businessId } });
  });

  it("both parties must accept: the proposer cannot accept their own revision; the seller's acceptance activates it", async () => {
    const p = await pair();
    const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes", terms: terms() });
    await lib.sendRateContract(p.buyer, c.id);
    await expect(lib.respondToRateContract(p.buyer, c.id, { revision: 1, decision: "accepted" })).rejects.toThrow(/You proposed this revision/);
    const view = await lib.respondToRateContract(p.seller, c.id, { revision: 1, decision: "accepted" });
    expect(view).toMatchObject({ status: "active", activeRevision: 1, phase: "in_force" });
    expect(view.current!.answers).toMatchObject({ buyer: "accepted", seller: "accepted" });
    expect(view.pending).toBeNull();
    await expect(lib.respondToRateContract(p.seller, c.id, { revision: 1, decision: "accepted" })).rejects.toThrow(/already in force/);
    expect((await events("RateContractActivated", c.id))[0]).toMatchObject({ version: 1, payload: { revision: 1, amendment: false } });
  });

  it("the seller counter-proposes; the buyer accepts the counter and it becomes the active revision", async () => {
    const p = await pair();
    const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes", terms: terms() });
    await lib.sendRateContract(p.buyer, c.id);
    const counter = await lib.proposeRateContractRevision(p.seller, c.id, terms({ items: [{ ...box, unitPricePaise: 2700 }], changeNote: "Board price rose" }));
    expect(counter).toMatchObject({ status: "proposed", latestRevision: 2, activeRevision: null });
    expect(counter.pending).toMatchObject({ revision: 2, proposedByRole: "seller", changeNote: "Board price rose" });
    expect(counter.history.map((h) => [h.revision, h.state])).toEqual([[2, "pending"], [1, "superseded"]]);
    await expect(lib.respondToRateContract(p.buyer, c.id, { revision: 1, decision: "accepted" })).rejects.toThrow(/newer revision/);
    const buyerView = await lib.getRateContract(p.buyer, c.id);
    expect(buyerView!.actions.respond).toBe(true);
    const active = await lib.respondToRateContract(p.buyer, c.id, { revision: 2, decision: "accepted" });
    expect(active).toMatchObject({ status: "active", activeRevision: 2 });
    expect(active.current!.items[0]!.unitPricePaise).toBe(2700);
  });

  it("declining needs a reason, leaves the proposal open for a changed revision and tells the proposer", async () => {
    const p = await pair();
    const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Boxes", terms: terms() });
    await lib.sendRateContract(p.buyer, c.id);
    await expect(lib.respondToRateContract(p.seller, c.id, { revision: 1, decision: "rejected" })).rejects.toThrow(/why/);
    const v = await lib.respondToRateContract(p.seller, c.id, { revision: 1, decision: "rejected", reason: "Price too low" });
    expect(v).toMatchObject({ status: "proposed", activeRevision: null });
    expect(v.pending!.answers).toMatchObject({ seller: "rejected", sellerReason: "Price too low" });
    expect(v.history[0]!.state).toBe("declined");
    expect((await events("RateContractRejected", c.id))[0]).toMatchObject({ payload: { reason: "Price too low", rejectedByBusinessId: p.seller.businessId } });
    expect((await lib.getRateContract(p.buyer, c.id))!.actions.callOff).toBe(false);
    const again = await lib.proposeRateContractRevision(p.buyer, c.id, terms({ items: [{ ...box, unitPricePaise: 2600 }] }));
    expect(again.latestRevision).toBe(2);
  });

  it("only the two parties can see or act on a contract", async () => {
    const x = await activeContract();
    const stranger = await party("stranger");
    expect(await lib.getRateContract(stranger, x.id)).toBeNull();
    await expect(lib.respondToRateContract(stranger, x.id, { revision: 1, decision: "accepted" })).rejects.toThrow(/not found/i);
    await expect(lib.proposeRateContractRevision(stranger, x.id, terms())).rejects.toThrow(/not found/i);
    await expect(lib.terminateRateContract(stranger, x.id, "nope nope")).rejects.toThrow(/not found/i);
    await expect(lib.placeCallOff(stranger, x.id, { addressId: x.addressId, lines: [{ itemKey: x.view.current!.items[0]!.itemKey, quantity: 100 }] })).rejects.toThrow(/not found/i);
    // a seller cannot place call-offs; only the buyer business can
    await expect(lib.placeCallOff(x.seller, x.id, { lines: [{ itemKey: x.view.current!.items[0]!.itemKey, quantity: 100 }] })).rejects.toThrow(/not found/i);
    expect((await lib.listRateContracts(stranger, { role: "buyer" })).items).toHaveLength(0);
  });

  it("refuses a contract with yourself, an unknown supplier and another supplier's product", async () => {
    const p = await pair();
    await expect(lib.createRateContract(p.buyer, { sellerBusinessId: p.buyer.businessId, title: "Self", terms: terms() })).rejects.toThrow(/Choose the supplier/);
    await expect(lib.createRateContract(p.buyer, { sellerBusinessId: "00000000-0000-4000-8000-000000000000", title: "Ghost", terms: terms() })).rejects.toThrow(/Choose the supplier/);
    await expect(lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Bad listing", terms: terms({ items: [{ ...box, listingId: "11111111-1111-4111-8111-111111111111" }] }) })).rejects.toThrow(/published products/);
  });
});

describe("amendments", () => {
  it("an amendment is pending until the other side accepts: the old terms stay in force, earlier call-offs keep their price", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1 }] });
    const key = x.view.current!.items[0]!.itemKey;
    const first = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    expect(first.callOff.lines[0]!.appliedPricePaise).toBe(2500);

    const proposed = await lib.proposeRateContractRevision(x.seller, x.id, terms({ items: [{ ...box, itemKey: key, moq: 1, unitPricePaise: 2800 }], changeNote: "New price from next month" }));
    expect(proposed).toMatchObject({ status: "active", activeRevision: 1, latestRevision: 2 });
    expect(proposed.current!.items[0]!.unitPricePaise).toBe(2500);
    expect(proposed.pending!.items[0]).toMatchObject({ unitPricePaise: 2800, itemKey: key, consumedQuantity: 100 });
    expect(proposed.actions.respond).toBe(false);
    expect((await events("RateContractProposed", x.id)).at(-1)).toMatchObject({ payload: { revision: 2, amendment: true } });

    const during = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 10 }] });
    expect(during.callOff.lines[0]!.appliedPricePaise).toBe(2500); // still the accepted revision

    const done = await lib.respondToRateContract(x.buyer, x.id, { revision: 2, decision: "accepted" });
    expect(done).toMatchObject({ activeRevision: 2, status: "active" });
    const after = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 10 }] });
    expect(after.callOff).toMatchObject({ revision: 2 });
    expect(after.callOff.lines[0]!.appliedPricePaise).toBe(2800);
    const prices = done.callOffs.map((o) => o.lines[0]!.appliedPricePaise);
    expect(prices).toEqual([2500, 2500]); // contract view before the third call-off
    expect((await lib.getRateContract(x.buyer, x.id))!.callOffs.map((o) => o.lines[0]!.appliedPricePaise)).toEqual([2800, 2500, 2500]);
    expect((await events("RateContractActivated", x.id)).at(-1)).toMatchObject({ payload: { revision: 2, amendment: true } });
  });

  it("revisions are immutable: earlier revisions keep their rows and a pending one is replaced by a newer proposal", async () => {
    const x = await activeContract();
    await lib.proposeRateContractRevision(x.seller, x.id, terms({ items: [{ ...box, unitPricePaise: 2900 }] }));
    const v3 = await lib.proposeRateContractRevision(x.buyer, x.id, terms({ items: [{ ...box, unitPricePaise: 2600 }] }));
    expect(v3.latestRevision).toBe(3);
    expect(v3.history.map((h) => [h.revision, h.state])).toEqual([[3, "pending"], [2, "superseded"], [1, "active"]]);
    const revs = await prisma.rateContractRevision.findMany({ where: { contractId: x.id }, orderBy: { revision: "asc" }, include: { items: true } });
    expect(revs.map((r) => Number(r.items[0]!.unitPricePaise))).toEqual([2500, 2900, 2600]);
    await expect(lib.respondToRateContract(x.buyer, x.id, { revision: 3, decision: "accepted" })).rejects.toThrow(/You proposed/);
    await expect(lib.respondToRateContract(x.seller, x.id, { revision: 2, decision: "accepted" })).rejects.toThrow(/newer revision/);
  });

  it("cannot be amended below what is already called off, nor drop a consumed item, nor move the start of a running contract", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1 }, { ...wire }] });
    const [b, w] = x.view.current!.items;
    await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: b!.itemKey, quantity: 600 }, { itemKey: w!.itemKey, quantity: 2 }] });
    const base = { ...box, moq: 1, itemKey: b!.itemKey };
    await expect(lib.proposeRateContractRevision(x.buyer, x.id, terms({ items: [{ ...base, quantityCap: 500 }, { ...wire, itemKey: w!.itemKey }] }))).rejects.toThrow(/cannot be below the 600/);
    await expect(lib.proposeRateContractRevision(x.buyer, x.id, terms({ items: [base] }))).rejects.toThrow(/cannot be removed/);
    await expect(lib.proposeRateContractRevision(x.buyer, x.id, terms({ validFrom: addDays(today(), 1), items: [base, { ...wire, itemKey: w!.itemKey }] }))).rejects.toThrow(/start date cannot change/);
    await expect(lib.proposeRateContractRevision(x.buyer, x.id, terms({ valueCapPaise: 1000, items: [base, { ...wire, itemKey: w!.itemKey }] }))).rejects.toThrow(/value cap/);
    await expect(lib.proposeRateContractRevision(x.buyer, x.id, terms({ items: [{ ...base, itemKey: "99999999-9999-4999-8999-999999999999" }] }))).rejects.toThrow(/Unknown item/);
    const ok = await lib.proposeRateContractRevision(x.buyer, x.id, terms({ items: [{ ...base, quantityCap: 2000 }, { ...wire, itemKey: w!.itemKey }] }));
    expect(ok.latestRevision).toBe(2);
  });
});

describe("call-off orders", () => {
  it("places an order and a purchase order at the locked contract price, without an RFQ, and tracks consumption", async () => {
    const x = await activeContract({ items: [{ ...box, listingId: undefined }, wire], valueCapPaise: 5_000_000 });
    const [b, w] = x.view.current!.items;
    const r = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, notes: "Dock 2", lines: [{ itemKey: b!.itemKey, quantity: 200 }, { itemKey: w!.itemKey, quantity: 3, unitPricePaise: 83000 }] });
    expect(r.purchaseOrderError).toBeNull();
    expect(r.callOff).toMatchObject({ callOffNo: 1, revision: 1, status: "placed", taxablePaise: 500_000 + 249_000 });
    expect(r.callOff.lines.map((l) => [l.contractPricePaise, l.appliedPricePaise])).toEqual([[2500, 2500], [80000, 83000]]);

    const order = await lib.getOrder(x.buyer, r.orderId);
    expect(order).toMatchObject({ status: "recorded", quantity: null, totalPaise: 749_000, matchId: null, enquiryId: null, role: "buyer" });
    expect(order!.enquiryTitle).toMatch(/^Call-off 1 on RC\//);
    expect(order!.buyerConfirmedAt).not.toBeNull();
    expect((await lib.getOrder(x.seller, r.orderId))!.actions.confirm).toBe(true);

    const po = r.purchaseOrder!;
    expect(po).toMatchObject({ orderId: r.orderId, status: "issued", paymentTermsDays: 30 });
    expect(po.lines.map((l) => [l.description, l.quantity, l.unitPricePaise, l.gstRateBps])).toEqual([[box.description, 200, 2500, 1800], [wire.description, 3, 83000, 1800]]);
    expect(po.totals.taxablePaise).toBe(749_000);

    const v = r.contract;
    expect(v.consumption).toMatchObject({ valueUsedPaise: 749_000, valueCapPaise: 5_000_000, valuePercent: 14 });
    expect(v.current!.items[0]).toMatchObject({ consumedQuantity: 200, remainingQuantity: 800, usedPercent: 20 });
    expect(await lib.rateContractLinkForOrder(x.seller, r.orderId)).toMatchObject({ contractId: x.id, callOffNo: 1 });
    expect(await lib.rateContractLinkForOrder(await party("other"), r.orderId)).toBeNull();
    const ev = await events("RateContractCallOffPlaced", x.id);
    expect(ev[0]).toMatchObject({ version: 1, payload: { callOffNo: 1, orderId: r.orderId, taxablePaise: 749_000, lineCount: 2 } });
    // the seller cannot see GSTIN or other buyer data through the event
    expect(JSON.stringify(ev[0]!.payload)).not.toMatch(/gstin/i);
  });

  it("enforces MOQ, quantity cap, value cap, price lock and the delivery address", async () => {
    const x = await activeContract({ valueCapPaise: 2_000_000 });
    const key = x.view.current!.items[0]!.itemKey;
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 99 }] })).rejects.toThrow(/minimum per call-off/);
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100, unitPricePaise: 1 }] })).rejects.toThrow(/fixed by the contract/);
    await expect(lib.placeCallOff(x.buyer, x.id, { lines: [{ itemKey: key, quantity: 100 }] })).rejects.toThrow(/delivery address/);
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: "00000000-0000-4000-8000-000000000000", lines: [{ itemKey: key, quantity: 100 }] })).rejects.toThrow(/saved addresses/);
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, expectedDelivery: "2020-01-01", lines: [{ itemKey: key, quantity: 100 }] })).rejects.toThrow(/delivery date/);
    await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 700 }] }); // 17,50,000 of 20,00,000
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 101 }] })).rejects.toThrow(/value limit/);
    await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    const final = await lib.getRateContract(x.buyer, x.id);
    expect(final!.callOffs).toHaveLength(2);
    expect(await prisma.order.count({ where: { buyerBusinessId: x.buyer.businessId } })).toBe(2); // failed attempts created nothing
  });

  it("two simultaneous call-offs cannot together exceed the quantity cap", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1, quantityCap: 100 }] });
    const key = x.view.current!.items[0]!.itemKey;
    const settled = await Promise.allSettled([60, 60, 60].map((quantity) => lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity }] })));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect((await lib.getRateContract(x.buyer, x.id))!.current!.items[0]!.consumedQuantity).toBe(60);
  });

  it("a retried call-off with the same idempotency key returns the original, also when two retries race", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1, quantityCap: 1000 }] });
    const key = x.view.current!.items[0]!.itemKey;
    const input = { addressId: x.addressId, idempotencyKey: "web-form-1", lines: [{ itemKey: key, quantity: 10 }] };
    const [a, b, c] = await Promise.all([lib.placeCallOff(x.buyer, x.id, input), lib.placeCallOff(x.buyer, x.id, input), lib.placeCallOff(x.buyer, x.id, input)]);
    expect(new Set([a.orderId, b.orderId, c.orderId]).size).toBe(1);
    const again = await lib.placeCallOff(x.buyer, x.id, input);
    expect(again.orderId).toBe(a.orderId);
    expect(again.purchaseOrder!.id).toBe(a.purchaseOrder!.id);
    const v = await lib.getRateContract(x.buyer, x.id);
    expect(v!.callOffs).toHaveLength(1);
    expect(v!.current!.items[0]!.consumedQuantity).toBe(10);
    const other = await lib.placeCallOff(x.buyer, x.id, { ...input, idempotencyKey: "web-form-2" });
    expect(other.callOff.callOffNo).toBe(2);
    await expect(lib.placeCallOff(x.buyer, x.id, { ...input, idempotencyKey: "k".repeat(101) })).rejects.toThrow(/100 characters/);
  });

  it("warns once at 80% and once at 100% of an item cap and of the value cap, to a versioned event", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1, quantityCap: 100 }], valueCapPaise: 250_000 });
    const key = x.view.current!.items[0]!.itemKey;
    const call = (quantity: number) => lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity }] });
    await call(50);
    expect(await events("RateContractConsumptionWarning", x.id)).toHaveLength(0);
    await call(30); // 80 of 100
    let w = await events("RateContractConsumptionWarning", x.id);
    expect(w.map((e) => [e.payload.scope, e.payload.threshold])).toEqual([["item", 80], ["value", 80]]);
    expect(w[0]).toMatchObject({ version: 1, payload: { itemDescription: box.description, usedPercent: 80 } });
    await call(5); // 85: nothing new
    expect(await events("RateContractConsumptionWarning", x.id)).toHaveLength(2);
    await call(15); // 100
    w = await events("RateContractConsumptionWarning", x.id);
    expect(w.map((e) => [e.payload.scope, e.payload.threshold])).toEqual([["item", 80], ["value", 80], ["item", 100], ["value", 100]]);
    await expect(call(1)).rejects.toThrow(/only 0 pcs/);
  });

  it("jumping straight past both thresholds announces only the highest", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1, quantityCap: 100 }] });
    await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: x.view.current!.items[0]!.itemKey, quantity: 100 }] });
    expect((await events("RateContractConsumptionWarning", x.id)).map((e) => e.payload.threshold)).toEqual([100]);
  });

  it("is refused before the start date, after the end, once terminated and for a draft; works without a PO when POs are off", async () => {
    const p = await pair();
    const future = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Later", terms: terms({ validFrom: addDays(today(), 10), validTo: addDays(today(), 100) }) });
    await lib.sendRateContract(p.buyer, future.id);
    const act = await lib.respondToRateContract(p.seller, future.id, { revision: 1, decision: "accepted" });
    expect(act).toMatchObject({ status: "active", phase: "not_started" });
    expect(act.actions.callOff).toBe(false);
    const key = act.current!.items[0]!.itemKey;
    await expect(lib.placeCallOff(p.buyer, future.id, { addressId: p.addressId, lines: [{ itemKey: key, quantity: 100 }] })).rejects.toThrow(/starts on/);

    const ended = await lib.placeCallOff(p.buyer, future.id, { addressId: p.addressId, lines: [{ itemKey: key, quantity: 100 }] }, new Date(Date.now() + 11 * 86_400_000));
    expect(ended.callOff.callOffNo).toBe(1); // inside the period, by clock
    await expect(lib.placeCallOff(p.buyer, future.id, { addressId: p.addressId, lines: [{ itemKey: key, quantity: 100 }] }, new Date(Date.now() + 120 * 86_400_000))).rejects.toThrow(/has ended/);

    const x = await activeContract();
    const k2 = x.view.current!.items[0]!.itemKey;
    await lib.terminateRateContract(x.seller, x.id, "Stopped trading this line");
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: k2, quantity: 100 }] })).rejects.toThrow(/terminated/);

    const d = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Draft", terms: terms() });
    await expect(lib.placeCallOff(p.buyer, d.id, { addressId: p.addressId, lines: [{ itemKey: key, quantity: 100 }] })).rejects.toThrow(/draft/);

    process.env.PURCHASE_ORDERS_ENABLED = "false";
    try {
      const y = await activeContract();
      const r = await lib.placeCallOff(y.buyer, y.id, { lines: [{ itemKey: y.view.current!.items[0]!.itemKey, quantity: 100 }] });
      expect(r.purchaseOrder).toBeNull();
      expect(r.purchaseOrderError).toBeNull();
      expect(await prisma.purchaseOrder.count({ where: { orderId: r.orderId } })).toBe(0);
    } finally {
      process.env.PURCHASE_ORDERS_ENABLED = "true";
    }
  });

  it("cancelling the order releases the quantities and says so; the PO is cancelled with it", async () => {
    const x = await activeContract({ items: [{ ...box, moq: 1, quantityCap: 100 }] });
    const key = x.view.current!.items[0]!.itemKey;
    const r = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 1 }] })).rejects.toThrow(/only 0 pcs/);
    await lib.transitionOrder(x.buyer, r.orderId, "cancelled");
    const v = await lib.getRateContract(x.buyer, x.id);
    expect(v!.callOffs[0]).toMatchObject({ status: "cancelled" });
    expect(v!.current!.items[0]).toMatchObject({ consumedQuantity: 0, remainingQuantity: 100 });
    expect(v!.consumption.valueUsedPaise).toBe(0);
    expect(await events("RateContractCallOffReleased", x.id)).toHaveLength(1);
    expect((await lib.getPurchaseOrder(x.buyer, r.purchaseOrder!.id))!.status).toBe("cancelled");
    const again = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    expect(again.callOff.callOffNo).toBe(2);
  });
});

describe("termination, expiry and renewal", () => {
  it("either party ends a contract with a reason; the other is told; orders already placed stand", async () => {
    const x = await activeContract();
    const key = x.view.current!.items[0]!.itemKey;
    const r = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    await expect(lib.terminateRateContract(x.buyer, x.id, "x")).rejects.toThrow(/reason/);
    const v = await lib.terminateRateContract(x.buyer, x.id, "Switching supplier");
    expect(v).toMatchObject({ status: "terminated", terminationReason: "Switching supplier", terminatedByRole: "buyer" });
    expect(v.actions).toMatchObject({ callOff: false, respond: false, propose: false, terminate: false });
    expect((await lib.getOrder(x.buyer, r.orderId))!.status).toBe("recorded");
    expect((await events("RateContractTerminated", x.id))[0]).toMatchObject({ version: 1, payload: { terminatedByBusinessId: x.buyer.businessId } });
    await expect(lib.terminateRateContract(x.seller, x.id, "again again")).rejects.toThrow(/already terminated/);
    await expect(lib.proposeRateContractRevision(x.seller, x.id, terms())).rejects.toThrow(/terminated/);
  });

  it("a buyer can discard an unsent draft without telling anyone", async () => {
    const p = await pair();
    const c = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Oops", terms: terms() });
    expect((await lib.terminateRateContract(p.buyer, c.id, "Created by mistake")).status).toBe("terminated");
    expect(await events("RateContractTerminated", c.id)).toHaveLength(0);
  });

  it("the sweep expires ended contracts and reminds both sides once at 30 days and once at 7 days, and never renews", async () => {
    const x = await activeContract({ validTo: addDays(today(), 20) });
    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    await lib.sweepRateContracts(at(0));
    let r = await events("RateContractExpiryReminder", x.id);
    expect(r.map((e) => e.payload.daysLeft)).toEqual([30]);
    await lib.sweepRateContracts(at(1)); // still the same stage: nothing new
    await lib.sweepRateContracts(at(10));
    expect((await events("RateContractExpiryReminder", x.id)).map((e) => e.payload.daysLeft)).toEqual([30]);
    await lib.sweepRateContracts(at(14)); // 6 days left
    await lib.sweepRateContracts(at(15));
    r = await events("RateContractExpiryReminder", x.id);
    expect(r.map((e) => [e.version, e.payload.daysLeft])).toEqual([[1, 30], [1, 7]]);
    expect(await events("RateContractExpired", x.id)).toHaveLength(0);

    await lib.sweepRateContracts(at(21));
    const after = await lib.getRateContract(x.buyer, x.id, at(21));
    expect(after).toMatchObject({ status: "expired", activeRevision: 1 });
    expect(await events("RateContractExpired", x.id)).toHaveLength(1);
    await lib.sweepRateContracts(at(22));
    expect(await events("RateContractExpired", x.id)).toHaveLength(1);
    expect(await events("RateContractExpiryReminder", x.id)).toHaveLength(2);
    await expect(lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: x.view.current!.items[0]!.itemKey, quantity: 100 }] }, at(22))).rejects.toThrow(/expired/);
    // nothing in the schema renews by itself
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name IN ('rate_contracts','rate_contract_revisions')`;
    expect(cols.map((c) => c.column_name).filter((n) => /renew/i.test(n))).toEqual(["renewed_from_id"]);
  });

  it("an explicit renewal is a NEW draft with the same terms and a later period that both sides must accept again", async () => {
    const x = await activeContract({ valueCapPaise: 9_000_000 });
    const renewal = await lib.startRateContractRenewal(x.buyer, x.id);
    expect(renewal).toMatchObject({ status: "draft", renewedFromId: x.id, activeRevision: null });
    expect(renewal.id).not.toBe(x.id);
    expect(renewal.number).not.toBe(x.view.number);
    expect(renewal.pending!.validFrom > x.view.current!.validTo).toBe(true);
    expect(renewal.pending).toMatchObject({ valueCapPaise: 9_000_000, paymentTermsDays: 30 });
    expect(renewal.pending!.items[0]!.consumedQuantity).toBe(0);
    expect((await lib.getRateContract(x.buyer, x.id))!.status).toBe("active"); // the old one is untouched
    await expect(lib.startRateContractRenewal(x.seller, x.id)).rejects.toThrow(/not found/i);
    await lib.sendRateContract(x.buyer, renewal.id);
    expect((await lib.respondToRateContract(x.seller, renewal.id, { revision: 1, decision: "accepted" })).status).toBe("active");
  });

  it("does nothing when the feature flag is off", async () => {
    process.env.RATE_CONTRACTS_ENABLED = "false";
    try {
      expect(await lib.sweepRateContracts()).toEqual({ expired: 0, reminded: 0 });
      const p = await pair();
      await expect(lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Off", terms: terms() })).rejects.toThrow(/not enabled/);
    } finally {
      process.env.RATE_CONTRACTS_ENABLED = "true";
    }
  });
});

describe("from an accepted quote", () => {
  it("pre-fills a draft from the quote for the buyer of that lead only", async () => {
    const buyer = await party("buyer");
    const seller = await party("seller", { isSeller: true });
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes", requirement: "Need boxes" } });
    enquiryIds.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    matchIds.push(m.id);
    const conv = await prisma.conversation.create({ data: { matchId: m.id } });
    const q = await prisma.quote.create({ data: { conversationId: conv.id, sellerBusinessId: seller.businessId, pricePaise: 29_500n, quantity: 100, unit: "pcs", paymentTerms: "net_15", deliveryTerms: "door_delivery", gstIncluded: true, moq: 50 } });

    const s = await lib.suggestFromQuote(buyer, q.id);
    expect(s).toMatchObject({ sellerBusinessId: seller.businessId, sourceQuoteId: q.id });
    expect(s!.terms).toMatchObject({ paymentTermsDays: 15, priceBasis: "delivered" });
    expect(s!.terms.items[0]).toMatchObject({ unit: "pcs", unitPricePaise: 25_000, gstRateBps: 1800, moq: 50 }); // GST backed out of the inclusive quote price
    expect(await lib.suggestFromQuote(seller, q.id)).toBeNull();

    const draft = await lib.createRateContractFromQuote(buyer, q.id);
    expect(draft).toMatchObject({ status: "draft", sourceQuoteId: q.id, role: "buyer" });
    expect(draft.title).toMatch(/Corrugated boxes/);
    await expect(lib.createRateContractFromQuote(seller, q.id)).rejects.toThrow(/not found/i);

    expect((await lib.listContractCounterparties(buyer)).map((c) => c.businessId)).toContain(seller.businessId);

    // an unaccepted lead cannot be converted
    await prisma.match.update({ where: { id: m.id }, data: { status: "offered" } });
    expect(await lib.suggestFromQuote(buyer, q.id)).toBeNull();
  });
});

describe("listing", () => {
  it("lists by role and status with a cursor, and flags what needs this party's answer", async () => {
    const p = await pair();
    const a = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Alpha", terms: terms() });
    const b = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Bravo", terms: terms() });
    await lib.sendRateContract(p.buyer, b.id);
    const mine = await lib.listRateContracts(p.buyer, { role: "buyer" });
    expect(mine.items.map((r) => r.title)).toEqual(["Bravo", "Alpha"]);
    expect((await lib.listRateContracts(p.buyer, { role: "buyer", status: "draft" })).items.map((r) => r.id)).toEqual([a.id]);
    const page1 = await lib.listRateContracts(p.buyer, { role: "buyer", limit: 1 });
    expect(page1.items).toHaveLength(1);
    const page2 = await lib.listRateContracts(p.buyer, { role: "buyer", limit: 1, cursor: page1.nextCursor });
    expect(page2.items[0]!.id).toBe(a.id);
    const theirs = await lib.listRateContracts(p.seller, { role: "seller" });
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]).toMatchObject({ id: b.id, needsAnswer: true, role: "seller" });
    expect((await lib.listRateContracts(p.seller, { role: "seller", status: "draft" })).items).toEqual([]);
    // a colleague at the same business sees the same data
    const colleague = await coPersonOf(p.seller, "colleague");
    expect((await lib.listRateContracts(colleague, { role: "seller" })).items).toHaveLength(1);
  });
});

describe("privacy (DPDP)", () => {
  it("the seller's export leaves out a buyer's unsent draft and the buyer's answers, but includes the contract once it is sent", async () => {
    const p = await pair();
    const draft = await lib.createRateContract(p.buyer, { sellerBusinessId: p.seller.businessId, title: "Private draft", terms: terms() });
    const ids = async (a: Actor) => ((await exportPersonalData(a.personId, { businessIds: [a.businessId] } as never)).rateContracts as unknown as { items: { id: string }[] }).items.map((c) => c.id);
    expect(await ids(p.seller)).not.toContain(draft.id);
    expect(await ids(p.buyer)).toContain(draft.id);
    await lib.sendRateContract(p.buyer, draft.id);
    expect(await ids(p.seller)).toContain(draft.id);
    const sellerRows = (await exportPersonalData(p.seller.personId, { businessIds: [p.seller.businessId] } as never)).rateContracts as unknown as { items: { id: string; revisions: { acceptances: { businessId: string }[] }[] }[] };
    const mine = sellerRows.items.find((c) => c.id === draft.id)!;
    expect(mine.revisions.flatMap((r) => r.acceptances).every((a) => a.businessId === p.seller.businessId)).toBe(true);
  });

  it("exports the person's contracts with revisions, answers and call-offs, and the retention purge clears personal references but keeps the record", async () => {
    const x = await activeContract();
    const key = x.view.current!.items[0]!.itemKey;
    const r = await lib.placeCallOff(x.buyer, x.id, { addressId: x.addressId, lines: [{ itemKey: key, quantity: 100 }] });
    await lib.terminateRateContract(x.buyer, x.id, "Switching supplier");

    const exp = await exportPersonalData(x.buyer.personId, { businessIds: [x.buyer.businessId] } as never);
    const list = (exp.rateContracts as unknown as { items: { id: string; revisions: { acceptances: unknown[]; items: unknown[] }[]; callOffs: unknown[] }[] }).items;
    const mine = list.find((c) => c.id === x.id)!;
    expect(mine.revisions[0]!.acceptances).toHaveLength(1); // only the requester business answers
    expect(mine.revisions[0]!.items).toHaveLength(1);
    expect(mine.callOffs).toHaveLength(1);

    await prisma.rateContract.update({ where: { id: x.id }, data: { updatedAt: new Date(Date.now() - 10 * 365 * 86_400_000) } });
    expect(await lib.purgeRateContracts(new Date(), { dryRun: true })).toBeGreaterThanOrEqual(1);
    const before = await prisma.rateContractAcceptance.count({ where: { revision: { contractId: x.id }, personId: { not: null } } });
    expect(before).toBe(2);
    await lib.purgeRateContracts(new Date(Date.now() - 365 * 86_400_000));
    const c = await prisma.rateContract.findUnique({ where: { id: x.id }, include: { revisions: { include: { acceptances: true, items: true } }, callOffs: true } });
    expect(c!.terminationReason).toBeNull();
    expect(c!.revisions[0]!.proposedByPersonId).toBeNull();
    expect(c!.revisions[0]!.acceptances.every((a) => a.personId === null)).toBe(true);
    expect(c!.callOffs[0]!.placedByPersonId).toBeNull();
    // the commercial record stays
    expect(c!.revisions[0]!.items).toHaveLength(1);
    expect(c!.callOffs[0]!.orderId).toBe(r.orderId);
    expect(Number(c!.callOffs[0]!.taxablePaise)).toBe(250_000);
  });
});
