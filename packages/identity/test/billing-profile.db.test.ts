import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { createBusiness, getBusinessBillingProfile } from "../src";

const people: string[] = [];
const biz: string[] = [];
afterAll(async () => {
  await prisma.businessMember.deleteMany({ where: { businessId: { in: biz } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
});
async function business(data: Parameters<typeof prisma.business.update>[0]["data"] = {}) {
  const p = await prisma.person.create({ data: { email: `bp-${randomUUID()}@example.test` } });
  people.push(p.id);
  const { businessId } = await createBusiness(p.id, { name: "Display Name", city: "Pune", state: "Maharashtra", pincode: "411001", isSeller: true });
  biz.push(businessId);
  await prisma.business.update({ where: { id: businessId }, data });
  return businessId;
}
// Random valid-shaped GSTIN (unique column): 2-digit state + 13 alphanumerics.
const gstin = (state: string) => `${state}${randomUUID().replace(/-/g, "").slice(0, 13).toUpperCase()}`;

describe("getBusinessBillingProfile", () => {
  it("returns null for malformed or unknown ids", async () => {
    expect(await getBusinessBillingProfile("nope")).toBeNull();
    expect(await getBusinessBillingProfile(randomUUID())).toBeNull();
  });
  it("prefers legal name and takes the state code from the GSTIN", async () => {
    const g = gstin("27");
    const id = await business({ legalName: "Legal Pvt Ltd", gstin: g, registeredAddress: { line1: "12 MG Road", stateCode: "29" } });
    expect(await getBusinessBillingProfile(id)).toEqual({ name: "Legal Pvt Ltd", gstin: g, address: "12 MG Road, Pune, Maharashtra, 411001", stateCode: "27" });
  });
  it("without a GSTIN falls back to the display name and the declared state code; ignores bad codes", async () => {
    const id = await business({ registeredAddress: { line1: "Plot 4", line2: "MIDC", city: "Nashik", state: "MH", pincode: "422001", stateCode: "27" } });
    expect(await getBusinessBillingProfile(id)).toEqual({ name: "Display Name", gstin: null, address: "Plot 4, MIDC, Nashik, MH, 422001", stateCode: "27" });
    const bad = await business({ registeredAddress: { stateCode: "Maharashtra", line1: 42 } });
    expect(await getBusinessBillingProfile(bad)).toMatchObject({ address: "Pune, Maharashtra, 411001", stateCode: null });
    const none = await business();
    expect((await getBusinessBillingProfile(none))?.stateCode).toBeNull();
  });
});
