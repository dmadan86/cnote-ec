import { prisma } from "@cnote/db";
import * as negotiation from "@cnote/negotiation";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addListing, cleanup, events, party, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return { ...a, listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id), getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null };
});

import {
  createBuyerMandate, createSellerMandate, getMandate, listActivity, listMandateChanges, listMandates, mandateProblem, pauseMandate, resumeMandate, revokeMandate, setAutoAccept, updateMandate, expireMandates,
} from "../src";

let b: Party, s: Party;
const bm = (over: Record<string, unknown> = {}) => ({ optIn: true as const, name: "Monthly boxes", title: "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes for shipping", quantity: 100, unit: "pcs", targetPricePaise: 4300, maxPricePaise: 4900, ...over });
beforeAll(async () => {
  b = await party("buyer");
  s = await party("seller");
  const l = addListing(s.businessId);
  await negotiation.upsertPriceBookEntry(s, l.id, { basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4000, moq: 50, leadTimeDays: 7, validityDays: 7 });
});
afterAll(cleanup);

describe("buyer mandates", () => {
  it("need explicit opt-in; auto-accept is off by default", async () => {
    await expect(createBuyerMandate(b, bm({ optIn: false }))).rejects.toMatchObject({ code: "validation" });
    await expect(createBuyerMandate(b, { ...bm(), optIn: undefined } as never)).rejects.toMatchObject({ code: "validation" });
    const m = await createBuyerMandate(b, bm());
    expect(m).toMatchObject({ side: "buyer", status: "active", autoAccept: false, autoAcceptLimitPaise: null, version: 1, limitPricePaise: 4900, maxRounds: 6 });
    expect(new Date(m.nextRunAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await events("AgentMandateCreated", m.id))[0]!.payload).toEqual({ mandateId: m.id, businessId: b.businessId, side: "buyer", autoAccept: false });
    const changes = await listMandateChanges(b.businessId, m.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ action: "created", byPerson: true, version: 1 });
  });
  it("validates bounds", async () => {
    await expect(createBuyerMandate(b, bm({ targetPricePaise: 5000 }))).rejects.toMatchObject({ message: expect.stringContaining("Target price") });
    await expect(createBuyerMandate(b, bm({ autoAccept: true }))).rejects.toMatchObject({ message: expect.stringContaining("Confirm") });
    await expect(createBuyerMandate(b, bm({ autoAccept: true, autoAcceptConsent: true }))).rejects.toMatchObject({ message: expect.stringContaining("ceiling") });
    await expect(createBuyerMandate(b, bm({ autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 5000 }))).rejects.toMatchObject({ message: expect.stringContaining("cannot be above") });
    await expect(createBuyerMandate(b, bm({ expiresAt: "2020-01-01" }))).rejects.toMatchObject({ message: expect.stringContaining("future") });
    await expect(createBuyerMandate(b, bm({ categorySlug: "definitely-not-a-category" }))).rejects.toMatchObject({ code: "validation" });
    await expect(createBuyerMandate(b, bm({ name: "x" }))).rejects.toMatchObject({ code: "validation" });
    await expect(createBuyerMandate(b, bm({ maxPricePaise: 10.5 }))).rejects.toMatchObject({ code: "validation" });
  });
  it("can be created with auto-accept by consent, updated, toggled, paused, resumed and revoked; every change is logged", async () => {
    const m = await createBuyerMandate(b, bm({ autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4500, approvedSellerIds: [s.businessId, s.businessId], recurrenceDays: 30 }));
    expect(m).toMatchObject({ autoAccept: true, autoAcceptLimitPaise: 4500, approvedSellerIds: [s.businessId], recurrenceDays: 30 });
    const u = await updateMandate(b, m.id, { limitPricePaise: 4800, name: "Renamed", deliveryCity: "Pune", deliveryPincode: "411001", maxRounds: 4, expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString() });
    expect(u).toMatchObject({ version: 2, limitPricePaise: 4800, name: "Renamed", deliveryCity: "Pune", maxRounds: 4 });
    await expect(updateMandate(b, m.id, { limitPricePaise: 4400 })).rejects.toMatchObject({ message: expect.stringContaining("auto-accept ceiling") });
    await expect(updateMandate(b, m.id, { capacityQty: 5 })).rejects.toMatchObject({ code: "validation" });
    await expect(updateMandate(b, m.id, { bogus: 1 } as never)).rejects.toMatchObject({ code: "validation" });
    const off = await setAutoAccept(b, m.id, { enabled: false });
    expect(off).toMatchObject({ autoAccept: false, autoAcceptLimitPaise: null });
    await expect(setAutoAccept(b, m.id, { enabled: true, limitPricePaise: 4000 })).rejects.toMatchObject({ message: expect.stringContaining("Confirm") });
    await expect(setAutoAccept(b, m.id, { enabled: true, consent: true, limitPricePaise: 9000 })).rejects.toMatchObject({ code: "validation" });
    const on = await setAutoAccept(b, m.id, { enabled: true, consent: true, limitPricePaise: 4200 });
    expect(on).toMatchObject({ autoAccept: true, autoAcceptLimitPaise: 4200 });
    expect((await pauseMandate(b, m.id)).status).toBe("paused");
    expect((await pauseMandate(b, m.id)).status).toBe("paused");
    await expect(resumeMandate(b, m.id).then((x) => x.status)).resolves.toBe("active");
    const r = await revokeMandate(b, m.id);
    expect(r).toMatchObject({ status: "revoked", autoAccept: false, nextRunAt: null });
    await expect(resumeMandate(b, m.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(updateMandate(b, m.id, { name: "zzz" })).rejects.toMatchObject({ code: "conflict" });
    const actions = (await listMandateChanges(b.businessId, m.id)).map((c) => c.action).reverse();
    expect(actions).toEqual(["created", "updated", "auto_accept_off", "auto_accept_on", "paused", "resumed", "revoked"]);
    expect((await listActivity(b.businessId, { mandateId: m.id })).length).toBeGreaterThanOrEqual(7);
  });
  it("is private to its business", async () => {
    const m = await createBuyerMandate(b, bm({ name: "Private one" }));
    expect(await getMandate(s.businessId, m.id)).toBeNull();
    expect(await getMandate(b.businessId, "nope")).toBeNull();
    await expect(pauseMandate(s, m.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await listMandateChanges(s.businessId, m.id)).toEqual([]);
    expect(await listMandateChanges(s.businessId, "x")).toEqual([]);
    expect((await listMandates(b.businessId, { side: "buyer" })).some((x) => x.id === m.id)).toBe(true);
    expect((await listMandates(s.businessId, { side: "buyer" })).length).toBe(0);
    expect((await listMandates(b.businessId, { status: "revoked" })).every((x) => x.status === "revoked")).toBe(true);
  });
  it("expired mandates are swept and recurrence re-arms an idle once-mandate", async () => {
    const m = await createBuyerMandate(b, bm({ name: "Short lived", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await prisma.agentMandate.update({ where: { id: m.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireMandates()).toBeGreaterThanOrEqual(1);
    expect((await getMandate(b.businessId, m.id))!.status).toBe("expired");
    await expect(resumeMandate(b, m.id)).rejects.toMatchObject({ code: "conflict" });
    const k = await createBuyerMandate(b, bm({ name: "Once only" }));
    await prisma.agentMandate.update({ where: { id: k.id }, data: { nextRunAt: null } });
    const re = await updateMandate(b, k.id, { recurrenceDays: 7 });
    expect(re.nextRunAt).not.toBeNull();
  });
});

describe("seller mandates", () => {
  it("need a price book, explicit opt-in and valid bounds", async () => {
    const naked = await party("naked");
    await expect(createSellerMandate(naked, { optIn: true, name: "Quote boxes" })).rejects.toMatchObject({ message: expect.stringContaining("price book") });
    await expect(createSellerMandate(s, { optIn: false as never, name: "Quote boxes" })).rejects.toMatchObject({ code: "validation" });
    await expect(createSellerMandate(s, { optIn: true, name: "Quote boxes", priceBookId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ message: expect.stringContaining("not found") });
    await expect(createSellerMandate(s, { optIn: true, name: "Quote boxes", autoAccept: true, autoAcceptConsent: true })).rejects.toMatchObject({ message: expect.stringContaining("lowest price") });
    await expect(createSellerMandate(s, { optIn: true, name: "Quote boxes", autoAccept: true })).rejects.toMatchObject({ message: expect.stringContaining("Confirm") });
    await expect(createSellerMandate(s, { optIn: true, name: "Quote boxes", floorPricePaise: 4500, autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4400 })).rejects.toMatchObject({ message: expect.stringContaining("floor") });
    const entry = (await negotiation.listPriceBook(s.businessId))[0]!;
    const m = await createSellerMandate(s, { optIn: true, name: "Quote boxes", priceBookId: entry.id, floorPricePaise: 4300, maxDiscountPct: 10, capacityQty: 500, categorySlug: null });
    expect(m).toMatchObject({ side: "seller", status: "active", autoAccept: false, limitPricePaise: 4300, maxDiscountPct: 10, capacityQty: 500, priceBookId: entry.id, nextRunAt: null });
    const u = await updateMandate(s, m.id, { capacityQty: 800, maxDiscountPct: 15, limitPricePaise: 4400, priceBookId: entry.id });
    expect(u).toMatchObject({ capacityQty: 800, maxDiscountPct: 15, limitPricePaise: 4400, version: 2 });
    await expect(updateMandate(s, m.id, { quantity: 5 })).rejects.toMatchObject({ code: "validation" });
    await expect(updateMandate(s, m.id, { priceBookId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "validation" });
    const on = await setAutoAccept(s, m.id, { enabled: true, consent: true, limitPricePaise: 4600 });
    expect(on).toMatchObject({ autoAccept: true, autoAcceptLimitPaise: 4600 });
    await expect(setAutoAccept(s, m.id, { enabled: true, consent: true, limitPricePaise: 4000 })).rejects.toMatchObject({ code: "validation" });
    await expect(setAutoAccept(s, "nope", { enabled: false })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("mandateProblem (pure)", () => {
  it("covers each rule", () => {
    const base = { targetPricePaise: null, limitPricePaise: 100, autoAccept: false, autoAcceptLimitPaise: null, expiresAt: null };
    expect(mandateProblem("buyer", { ...base, limitPricePaise: null })).toMatch(/maximum price/);
    expect(mandateProblem("buyer", base)).toBeNull();
    expect(mandateProblem("seller", { ...base, autoAccept: true, autoAcceptLimitPaise: 50 })).toMatch(/floor/);
    expect(mandateProblem("seller", { ...base, limitPricePaise: null, autoAccept: true, autoAcceptLimitPaise: 50 })).toBeNull();
  });
});
