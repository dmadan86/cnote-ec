import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  addAddress, createBusiness, deleteAddress, erasePerson, exportPersonalData, getBuyerBusinessProfile, getDefaultDeliveryPincode,
  GstnProviderError, gstinCheckChar, listAddresses, mockProvider, setDefaultAddress, setGstnProvider, updateAddress, verifyGstin,
} from "../src";

const people: string[] = [];
const biz: string[] = [];
afterAll(async () => {
  await prisma.businessAddress.deleteMany({ where: { businessId: { in: biz } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: biz } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: biz } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  await prisma.consent.deleteMany({ where: { personId: { in: people } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
});
afterEach(() => {
  setGstnProvider(null);
  mockProvider.clearFixtures();
});

async function buyer(isSeller = false) {
  const p = await prisma.person.create({ data: { email: `ba-${randomUUID()}@example.test` } });
  people.push(p.id);
  const { businessId } = await createBusiness(p.id, { name: "Buyer Co", city: "Pune", state: "Maharashtra", pincode: "411001", isSeller });
  biz.push(businessId);
  return { personId: p.id, businessId };
}
const rl = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
const rd = () => String(Math.floor(Math.random() * 10));
/** Valid, unique tax id: state code + PAN-shaped 10 chars + entity digit + Z + checksum. `code` is the 13th char (mock behaviour switch). */
function taxId(state = "27", code = "1") {
  const pan = `${rl()}${rl()}${rl()}${rl()}${rl()}${rd()}${rd()}${rd()}${rd()}${rl()}`;
  const body = `${state}${pan}${code}Z`;
  return body + gstinCheckChar(body);
}
const addr = (o: Record<string, unknown> = {}) => ({ label: "Warehouse", line1: "12 MG Road", city: "Pune", pincode: "411001", state: "Maharashtra", ...o });

describe("delivery addresses", () => {
  it("first address becomes default; switching default keeps exactly one", async () => {
    const { businessId } = await buyer();
    const a = await addAddress(businessId, addr());
    expect(a).toMatchObject({ isDefault: true, stateCode: "27", state: "Maharashtra" });
    const b = await addAddress(businessId, addr({ label: "Office", pincode: "560001", state: "Karnataka", city: "Bengaluru" }));
    expect(b.isDefault).toBe(false);
    expect(await getDefaultDeliveryPincode(businessId)).toBe("411001");
    await setDefaultAddress(businessId, b.id);
    expect(await getDefaultDeliveryPincode(businessId)).toBe("560001");
    const c = await addAddress(businessId, addr({ label: "Third", makeDefault: true }));
    const all = await listAddresses(businessId);
    expect(all.filter((x) => x.isDefault).map((x) => x.id)).toEqual([c.id]);
    expect(all[0]!.id).toBe(c.id);
  });
  it("validates pincode, phone and state", async () => {
    const { businessId } = await buyer();
    await expect(addAddress(businessId, addr({ pincode: "12345" }))).rejects.toThrow();
    await expect(addAddress(businessId, addr({ pincode: "011001" }))).rejects.toThrow();
    await expect(addAddress(businessId, addr({ phone: "12345" }))).rejects.toThrow();
    await expect(addAddress(businessId, addr({ state: "Atlantis" }))).rejects.toMatchObject({ code: "validation" });
    expect(await addAddress(businessId, addr({ phone: "+919876543210" }))).toMatchObject({ phone: "+919876543210" });
  });
  it("treats blank optional fields (as posted by a form) as absent", async () => {
    const { businessId } = await buyer();
    const a = await addAddress(businessId, addr({ contactName: "", phone: "", line2: "" }));
    expect(a).toMatchObject({ contactName: null, phone: null, line2: null });
  });
  it("update, delete (promotes a new default) and tenant isolation", async () => {
    const x = await buyer();
    const y = await buyer();
    const a = await addAddress(x.businessId, addr());
    const b = await addAddress(x.businessId, addr({ label: "Two" }));
    await expect(updateAddress(y.businessId, a.id, addr())).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteAddress(y.businessId, a.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(setDefaultAddress(y.businessId, a.id)).rejects.toMatchObject({ code: "not_found" });
    const u = await updateAddress(x.businessId, a.id, addr({ label: "HQ", pincode: "110001", state: "Delhi", city: "New Delhi" }));
    expect(u).toMatchObject({ label: "HQ", stateCode: "07", isDefault: true });
    await deleteAddress(x.businessId, a.id);
    expect((await listAddresses(x.businessId)).map((r) => [r.id, r.isDefault])).toEqual([[b.id, true]]);
    await deleteAddress(x.businessId, b.id);
    expect(await getDefaultDeliveryPincode(x.businessId)).toBeNull();
  });
  it("caps addresses per business", async () => {
    const { businessId } = await buyer();
    for (let i = 0; i < 10; i++) await addAddress(businessId, addr({ label: `A${i}` }));
    await expect(addAddress(businessId, addr())).rejects.toThrow(/up to 10/);
  });
});

describe("buyer GSTIN verification", () => {
  it("passes with the mock provider, returns legal name + state, applies tier 1", async () => {
    const { businessId } = await buyer();
    const g = taxId("29");
    const r = await verifyGstin(businessId, g.toLowerCase());
    expect(r).toMatchObject({ passed: true, tier: 1, state: "Karnataka" });
    expect(r.legalName).toBeTruthy();
    const p = await getBuyerBusinessProfile(businessId);
    expect(p).toMatchObject({ gstin: g, gstState: "Karnataka", gstStatus: "Active", verificationTier: 1, legalName: r.legalName });
    expect(p?.gstVerifiedAt).toBeTruthy();
  });
  it("rejects a bad checksum, an unknown and a cancelled GSTIN without changing the tier", async () => {
    const { businessId } = await buyer();
    const good = taxId();
    const wrong = good.slice(0, 14) + (good[14] === "A" ? "B" : "A");
    expect(await verifyGstin(businessId, wrong)).toMatchObject({ passed: false, tier: 0 });
    expect(await verifyGstin(businessId, taxId("27", "N"))).toMatchObject({ passed: false, tier: 0, reason: expect.stringContaining("not found") });
    expect(await verifyGstin(businessId, taxId("27", "C"))).toMatchObject({ passed: false, tier: 0, reason: expect.stringContaining("cancelled") });
    expect((await getBuyerBusinessProfile(businessId))?.gstin).toBeNull();
  });
  it("a provider outage is reported without recording a failed verification", async () => {
    const { businessId } = await buyer();
    setGstnProvider({ name: "down", lookup: async () => { throw new GstnProviderError("unavailable", "down"); } });
    const r = await verifyGstin(businessId, taxId());
    expect(r).toMatchObject({ passed: false, reason: expect.stringContaining("unavailable") });
    expect(await prisma.verificationRecord.count({ where: { businessId } })).toBe(0);
  });
  it("refuses a GSTIN already on another business", async () => {
    const a = await buyer();
    const b = await buyer();
    const g = taxId();
    expect((await verifyGstin(a.businessId, g)).passed).toBe(true);
    expect(await verifyGstin(b.businessId, g)).toMatchObject({ passed: false, reason: expect.stringContaining("already registered") });
  });
  it("profile of an unknown business is null", async () => {
    expect(await getBuyerBusinessProfile(randomUUID())).toBeNull();
  });
});

describe("DPDP export and erasure", () => {
  it("exports addresses and the GSTIN; erasure removes them for a sole-member buyer business", async () => {
    const { personId, businessId } = await buyer();
    const g = taxId();
    await verifyGstin(businessId, g);
    await addAddress(businessId, addr());
    const out = (await exportPersonalData(personId)) as { deliveryAddresses: { line1: string }[]; businesses: { gstin: string }[] };
    expect(out.deliveryAddresses).toHaveLength(1);
    expect(out.deliveryAddresses[0]!.line1).toBe("12 MG Road");
    expect(out.businesses[0]!.gstin).toBe(g);
    await erasePerson(personId);
    expect(await listAddresses(businessId)).toEqual([]);
    expect(await getBuyerBusinessProfile(businessId)).toMatchObject({ gstin: null, legalName: null, verificationTier: 0 });
  });
  it("keeps seller business tax identifiers (retention) but still deletes addresses", async () => {
    const { personId, businessId } = await buyer(true);
    const g = taxId();
    await verifyGstin(businessId, g);
    await addAddress(businessId, addr());
    await erasePerson(personId);
    expect(await listAddresses(businessId)).toEqual([]);
    expect((await getBuyerBusinessProfile(businessId))?.gstin).toBe(g);
  });
  it("does not touch a business shared with another member", async () => {
    const { personId, businessId } = await buyer();
    const other = await prisma.person.create({ data: { email: `ba-${randomUUID()}@example.test` } });
    people.push(other.id);
    await prisma.businessMember.create({ data: { businessId, personId: other.id, role: "staff" } });
    await addAddress(businessId, addr());
    await erasePerson(personId);
    expect(await listAddresses(businessId)).toHaveLength(1);
  });
});
