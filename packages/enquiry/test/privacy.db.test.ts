import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

const personId = randomUUID();
let businessId: string | undefined;
afterAll(async () => {
  await prisma.enquiry.deleteMany({ where: { buyerPersonId: personId } });
  await prisma.domainEvent.deleteMany({ where: { aggregateType: "Enquiry", payload: { path: ["buyerPersonId"], equals: personId } } });
  if (businessId) await prisma.business.deleteMany({ where: { id: businessId } });
  await prisma.person.deleteMany({ where: { id: personId } });
});

describe("exportPersonalData (DPDP access right)", () => {
  it("exports the person's requirements; seller-side/other data of other people is not included", async () => {
    await prisma.person.create({ data: { id: personId, email: `eq-${personId}@example.test` } });
    businessId = (await prisma.business.create({ data: { name: `eq-${personId}` } })).id;
    await prisma.enquiry.create({
      data: { buyerBusinessId: businessId, buyerPersonId: personId, title: "Need 5000 cartons", requirement: "5-ply, 12x10x8", targetPricePaise: 1_234_567_890_123n },
    });
    const out = (await exportPersonalData(personId, { businessIds: [businessId] })) as Record<string, { items: any[]; truncated: boolean }>;
    expect(out.enquiries!.items).toHaveLength(1);
    expect(out.enquiries!.items[0]).toMatchObject({ title: "Need 5000 cartons", targetPricePaise: 1_234_567_890_123n });
    expect(out.enquiries!.items[0]).not.toHaveProperty("intentScore");
    for (const k of ["messages", "quotes", "orders", "dealReports", "attachments"]) expect(out[k]!.items, k).toEqual([]);
  });
  it("works without business context", async () => {
    const out = (await exportPersonalData(randomUUID(), { businessIds: [] })) as Record<string, { items: unknown[] }>;
    for (const k of ["enquiries", "messages", "quotes", "orders", "dealReports", "attachments"]) expect(out[k]!.items, k).toEqual([]);
  });
});
