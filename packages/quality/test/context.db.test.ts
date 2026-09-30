import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/identity", async (orig) => ({
  ...(await orig<object>()),
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, name: `Biz ${i.slice(0, 4)}` }])),
}));

import { upsertCategories } from "@cnote/catalogue";
import { buildChecklist, buildExpectedSpec, defaultOrderContextPort, getSubmissionContext, setOrderContextPort } from "../src";

const tag = `qctx-${Date.now()}`;
const ids: { biz: string[]; person: string[]; enquiry: string[]; match: string[]; order: string[]; listing: string[]; cat: string[] } = { biz: [], person: [], enquiry: [], match: [], order: [], listing: [], cat: [] };

async function party(n: string) {
  const p = await prisma.person.create({ data: { name: `${tag}-${n}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${n}` } });
  ids.person.push(p.id); ids.biz.push(b.id);
  return { personId: p.id, businessId: b.id };
}

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: ids.order } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids.listing } } });
  await prisma.match.deleteMany({ where: { id: { in: ids.match } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: ids.enquiry } } });
  await prisma.category.deleteMany({ where: { id: { in: ids.cat } } });
  await prisma.business.deleteMany({ where: { id: { in: ids.biz } } });
  await prisma.person.deleteMany({ where: { id: { in: ids.person } } });
});

describe("default order context port", () => {
  it("derives category, quantity and attributes from the real order, enquiry and seller listing", async () => {
    const buyer = await party("buyer"); const seller = await party("seller");
    const slug = `${tag}-boxes`;
    const [cat] = await upsertCategories([{ slug, name: "Boxes" }]);
    ids.cat.push(cat!.id);
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, categoryId: cat!.id, title: "Corrugated boxes", requirement: "3 ply brown boxes", quantity: 100, quantityUnit: "piece" } });
    ids.enquiry.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    ids.match.push(m.id);
    const l = await prisma.listing.create({ data: { sellerBusinessId: seller.businessId, categoryId: cat!.id, title: "Corrugated boxes 3 ply", attributes: { ply: 3, brand: "Acme" } } });
    ids.listing.push(l.id);
    const o = await prisma.order.create({ data: { matchId: m.id, enquiryId: e.id, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, status: "confirmed", quantity: 100, unit: "piece" } });
    ids.order.push(o.id);

    const ctx = await defaultOrderContextPort.load(seller, o.id);
    expect(ctx).toMatchObject({ role: "seller", status: "confirmed", categorySlug: slug, sellerBusinessId: seller.businessId });
    expect(ctx!.spec).toMatchObject({ quantity: 100, unit: "piece", requirement: "3 ply brown boxes", attributes: { ply: 3, brand: "Acme" } });
    expect(ctx!.spec.labelling).toContain("brand Acme");

    const buyerCtx = await defaultOrderContextPort.load(buyer, o.id);
    expect(buyerCtx).toMatchObject({ role: "buyer", categorySlug: null });
    expect(await defaultOrderContextPort.load({ personId: randomUUID(), businessId: randomUUID() }, o.id)).toBeNull();

    // end-to-end eligibility through the default port (flag on, category allowlisted)
    process.env.QUALITY_CHECKS_ENABLED = "true"; process.env.QUALITY_CHECK_CATEGORIES = slug;
    setOrderContextPort(null);
    expect(await getSubmissionContext(seller, o.id)).toMatchObject({ eligible: true, categorySlug: slug });
    expect(await getSubmissionContext(buyer, o.id)).toMatchObject({ eligible: false, reason: "not_seller" });
    delete process.env.QUALITY_CHECKS_ENABLED; delete process.env.QUALITY_CHECK_CATEGORIES;
  });

  it("orders without a matching listing still load with empty attributes", async () => {
    const buyer = await party("buyer2"); const seller = await party("seller2");
    const [cat] = await upsertCategories([{ slug: `${tag}-none`, name: "None" }]);
    ids.cat.push(cat!.id);
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, categoryId: cat!.id, title: "Widgets", requirement: "widgets" } });
    ids.enquiry.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    ids.match.push(m.id);
    const o = await prisma.order.create({ data: { matchId: m.id, enquiryId: e.id, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId } });
    ids.order.push(o.id);
    const ctx = await defaultOrderContextPort.load(seller, o.id);
    expect(ctx!.spec.attributes).toEqual({});
    expect(ctx!.spec.quantity).toBeNull();
  });
});

describe("spec helpers", () => {
  it("buildExpectedSpec bounds and cleans; buildChecklist falls back gracefully", () => {
    const spec = buildExpectedSpec({ title: "  A   B ", quantity: null, unit: null, requirement: "x".repeat(900), attributes: { ["k".repeat(60)]: "v".repeat(200), n: 5, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a${i}`, i])) } });
    expect(spec.productTitle).toBe("A B");
    expect(spec.requirement).toHaveLength(500);
    expect(Object.keys(spec.attributes).length).toBeLessThanOrEqual(20);
    const cl = buildChecklist({ ...spec, attributes: {}, requirement: "", labelling: [] });
    expect(cl[0]!.expected).toMatch(/not recorded/);
    expect(cl[1]!.expected).toMatch(/No specific/);
    expect(cl[2]!.expected).toBe("A B");
    expect(buildChecklist({ ...spec, quantity: 5, unit: null, attributes: {}, requirement: "brown" })[2]!.expected).toBe("brown");
  });
});
