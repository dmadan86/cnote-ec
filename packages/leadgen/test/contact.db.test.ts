import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { setConsent } from "@cnote/identity";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listing: null as null | { id: string; sellerBusinessId: string },
  enquiries: [] as unknown[],
}));
vi.mock("@cnote/catalogue", () => ({ getPublicListing: async (id: string) => (state.listing?.id === id ? state.listing : null) }));
vi.mock("@cnote/enquiry", () => ({ createEnquiry: async () => ({ id: "x" }), listBuyerEnquiries: async () => state.enquiries }));

import { getUnlockedSupplierContact, recordSupplierContacted } from "../src";

const personIds: string[] = [];
const bizIds: string[] = [];
const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, "0");

async function actor(opts: { phone?: string; email?: string } = {}) {
  const p = await prisma.person.create({ data: { phone: opts.phone ?? null, email: opts.email ?? null, phoneVerifiedAt: new Date() } });
  personIds.push(p.id);
  const b = await prisma.business.create({ data: { name: `contact-test-${p.id}` } });
  bizIds.push(b.id);
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id, role: "owner" } });
  return { personId: p.id, businessId: b.id };
}

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE type = 'SupplierContacted' AND payload->>'buyerPersonId' = ANY(${personIds})`;
  await prisma.domainEvent.deleteMany({ where: { aggregateType: "Person", aggregateId: { in: personIds } } });
  await prisma.consent.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.businessMember.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

let buyer: Awaited<ReturnType<typeof actor>>;
let seller: Awaited<ReturnType<typeof actor>>;
let phone = "";
const enquiry = (status: string, sellerBusinessId = seller.businessId) => ({
  id: randomUUID(),
  matches: [{ sellerBusinessId, status, sellerName: "Acme Packs", conversationId: "conv-1" }],
});

beforeEach(async () => {
  phone = `+9190${digits()}`;
  buyer = await actor();
  seller = await actor({ phone: `+9190${digits()}`, email: `s-${randomUUID()}@example.test` });
  state.listing = { id: randomUUID(), sellerBusinessId: seller.businessId };
  state.enquiries = [];
});

describe("getUnlockedSupplierContact", () => {
  it("is locked with no accepted match, and for a pending or declined one", async () => {
    expect(await getUnlockedSupplierContact(buyer.personId, state.listing!.id)).toEqual({ unlocked: false });
    state.enquiries = [enquiry("offered")];
    expect(await getUnlockedSupplierContact(buyer.personId, state.listing!.id)).toEqual({ unlocked: false });
    state.enquiries = [enquiry("declined")];
    expect(await getUnlockedSupplierContact(buyer.personId, state.listing!.id)).toEqual({ unlocked: false });
  });

  it("is locked for a match with a different supplier, an unknown listing and a malformed id", async () => {
    state.enquiries = [enquiry("accepted", randomUUID())];
    expect(await getUnlockedSupplierContact(buyer.personId, state.listing!.id)).toEqual({ unlocked: false });
    expect(await getUnlockedSupplierContact(buyer.personId, randomUUID())).toEqual({ unlocked: false });
    expect(await getUnlockedSupplierContact(buyer.personId, "nope")).toEqual({ unlocked: false });
  });

  it("returns no number or email when the supplier has not agreed to share (their contact preference)", async () => {
    state.enquiries = [enquiry("accepted")];
    const r = await getUnlockedSupplierContact(buyer.personId, state.listing!.id);
    expect(r).toMatchObject({ unlocked: true, phone: null, whatsapp: null, email: null, conversationId: "conv-1" });
  });

  it("returns phone, wa.me digits and email once the supplier shares and the match is accepted", async () => {
    await prisma.person.update({ where: { id: seller.personId }, data: { phone } });
    await setConsent(seller.personId, "counterparty_sharing", true, "test");
    state.enquiries = [enquiry("accepted")];
    const r = await getUnlockedSupplierContact(buyer.personId, state.listing!.id);
    expect(r).toMatchObject({ unlocked: true, phone, whatsapp: phone.slice(1), sellerName: "Acme Packs" });
    expect((r as { email: string }).email).toMatch(/@example\.test$/);
    // withdrawing the consent closes it again (append-only ledger: the latest entry wins)
    await setConsent(seller.personId, "counterparty_sharing", false, "test");
    expect(await getUnlockedSupplierContact(buyer.personId, state.listing!.id)).toMatchObject({ unlocked: true, phone: null, email: null });
  });
});

describe("recordSupplierContacted", () => {
  it("refuses while locked and logs one versioned event, without any contact detail, once unlocked", async () => {
    await expect(recordSupplierContacted(buyer.personId, state.listing!.id, "call")).rejects.toMatchObject({ code: "forbidden" });
    await prisma.person.update({ where: { id: seller.personId }, data: { phone } });
    await setConsent(seller.personId, "counterparty_sharing", true, "test");
    const e = enquiry("accepted");
    state.enquiries = [e];
    await recordSupplierContacted(buyer.personId, state.listing!.id, "whatsapp");
    const rows = await prisma.domainEvent.findMany({ where: { type: "SupplierContacted", aggregateId: e.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.payload).toMatchObject({ buyerPersonId: buyer.personId, sellerBusinessId: seller.businessId, channel: "whatsapp" });
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(phone);
    await prisma.domainEvent.deleteMany({ where: { aggregateId: e.id } });
  });

  it("rejects an unknown channel", async () => {
    await expect(recordSupplierContacted(buyer.personId, state.listing!.id, "sms" as never)).rejects.toMatchObject({ code: "validation" });
  });
});
