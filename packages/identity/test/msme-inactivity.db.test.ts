// MSME declaration + party profiles (IT Act s.43B(h)) and the inactivity helpers (DPDP Rules r.8).
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  describePersonForStaff, findPersonIdByEmail, getMsmeStatus, getOwnContacts, getPartyProfiles, isInactivityEligible, isMsmeCategory, listInactiveAccounts,
  msmeCovered, setMsmeDeclaration,
} from "../src";

const UDYAM = "UDYAM-MH-26-0001235";
const DAY = 86_400_000;
const bizIds: string[] = [];
const personIds: string[] = [];
afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.staffMember.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.authSession.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});
async function biz(o: Record<string, unknown> = {}) {
  const b = await prisma.business.create({ data: { name: `Msme ${randomUUID().slice(0, 6)}`, isSeller: true, ...o } });
  bizIds.push(b.id);
  return b;
}
async function person(o: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.person.create({ data: { id, email: `in-${id.slice(0, 8)}@example.com`, createdAt: new Date(Date.now() - 400 * DAY), ...o } });
  personIds.push(id);
  return id;
}

describe("MSME status", () => {
  it("isMsmeCategory / msmeCovered", () => {
    expect(isMsmeCategory("micro")).toBe(true);
    expect(isMsmeCategory("huge")).toBe(false);
    expect(isMsmeCategory(3)).toBe(false);
    expect(msmeCovered("micro", UDYAM)).toBe(true);
    expect(msmeCovered("small", UDYAM)).toBe(true);
    expect(msmeCovered("medium", UDYAM)).toBe(false);
    expect(msmeCovered("micro", null)).toBe(false);
    expect(msmeCovered("micro", "not-a-udyam")).toBe(false);
    expect(msmeCovered(undefined, UDYAM)).toBe(false);
  });

  it("getMsmeStatus: unknown business, undeclared, and covered", async () => {
    expect(await getMsmeStatus(randomUUID())).toBeNull();
    const plain = await biz();
    expect(await getMsmeStatus(plain.id)).toMatchObject({ category: null, declaredAt: null, udyamOnFile: false, covered: false });
    const declared = await biz({ udyam: UDYAM, msmeCategory: "small", msmeDeclaredAt: new Date() });
    expect(await getMsmeStatus(declared.id)).toMatchObject({ category: "small", udyamOnFile: true, covered: true });
    const badUdyam = await biz({ udyam: "bogus", msmeCategory: "bogus" });
    expect(await getMsmeStatus(badUdyam.id)).toMatchObject({ category: null, udyamOnFile: false, covered: false });
  });

  it("setMsmeDeclaration validates, guards, is idempotent, emits once and clears", async () => {
    const b = await biz({ udyam: UDYAM });
    await expect(setMsmeDeclaration(b.id, "giant" as never)).rejects.toMatchObject({ code: "validation" });
    await expect(setMsmeDeclaration(randomUUID(), "micro")).rejects.toMatchObject({ code: "not_found" });
    const buyer = await biz({ isSeller: false });
    await expect(setMsmeDeclaration(buyer.id, "micro")).rejects.toMatchObject({ code: "forbidden" });

    const s = await setMsmeDeclaration(b.id, "micro");
    expect(s).toMatchObject({ category: "micro", covered: true, udyamOnFile: true });
    expect(s.declaredAt).not.toBeNull();
    await setMsmeDeclaration(b.id, "micro"); // no change: no second event
    expect(await prisma.domainEvent.count({ where: { aggregateId: b.id, type: "BusinessMsmeDeclared" } })).toBe(1);
    const cleared = await setMsmeDeclaration(b.id, null);
    expect(cleared).toMatchObject({ category: null, declaredAt: null, covered: false });
    expect(await prisma.domainEvent.count({ where: { aggregateId: b.id, type: "BusinessMsmeDeclared" } })).toBe(2);

    const noUdyam = await biz();
    expect((await setMsmeDeclaration(noUdyam.id, "small")).udyamOnFile).toBe(false);
  });

  it("getPartyProfiles dedupes ids and resolves the state from GSTIN, else address", async () => {
    expect((await getPartyProfiles([])).size).toBe(0);
    const g = await biz({ gstin: "27AAPFU0939F1ZV", legalName: "Legal Pvt", registeredAddress: { stateCode: "29" }, udyam: UDYAM, msmeCategory: "micro" });
    const a = await biz({ registeredAddress: { stateCode: "29" } });
    const badAddr = await biz({ registeredAddress: { stateCode: "Karnataka" } });
    const nullAddr = await biz();
    const m = await getPartyProfiles([g.id, g.id, a.id, badAddr.id, nullAddr.id]);
    expect(m.size).toBe(4);
    expect(m.get(g.id)).toMatchObject({ stateCode: "27", gstin: "27AAPFU0939F1ZV", legalName: "Legal Pvt", msme: { category: "micro", covered: true, udyamOnFile: true } });
    expect(m.get(a.id)?.stateCode).toBe("29");
    expect(m.get(badAddr.id)?.stateCode).toBeNull();
    expect(m.get(nullAddr.id)).toMatchObject({ stateCode: null, msme: { category: null, covered: false, udyamOnFile: false } });
  });
});

describe("inactivity helpers", () => {
  it("excludes staff, seller members, live sessions and recently-used sessions", async () => {
    const before = new Date(Date.now() - 100 * DAY);
    const plain = await person();
    const seller = await person();
    const sb = await biz();
    await prisma.businessMember.create({ data: { personId: seller, businessId: sb.id, role: "owner" } });
    const live = await person();
    await prisma.authSession.create({ data: { personId: live, refreshTokenHash: `h-${randomUUID()}`, expiresAt: new Date(Date.now() + DAY), lastUsedAt: new Date(Date.now() - 300 * DAY) } });
    const lagging = await person();
    await prisma.authSession.create({ data: { personId: lagging, refreshTokenHash: `h-${randomUUID()}`, expiresAt: new Date(Date.now() - DAY), revokedAt: new Date(), lastUsedAt: new Date(Date.now() - 5 * DAY) } });
    const staff = await person();
    await prisma.staffMember.create({ data: { personId: staff, roles: ["support"] } });

    const rows = await listInactiveAccounts(before, 5000);
    const ids = rows.map((r) => r.personId);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(seller);
    expect(ids).not.toContain(live);
    expect(ids).not.toContain(lagging);
    expect(ids).not.toContain(staff);
    const row = rows.find((r) => r.personId === plain)!;
    expect(row.lastActiveAt.getTime()).toBe((await prisma.person.findUniqueOrThrow({ where: { id: plain } })).createdAt.getTime());
    expect(row.email).toContain("@example.com");
    expect(await isInactivityEligible(plain)).toBe(true);
    expect(await isInactivityEligible(seller)).toBe(false);
    expect(await isInactivityEligible(live)).toBe(false);
    expect(await isInactivityEligible(staff)).toBe(false);
  });

  it("findPersonIdByEmail trims and lower-cases; blank and unknown give null", async () => {
    const id = await person({ email: `mixed-${randomUUID().slice(0, 6)}@example.com` });
    const email = (await prisma.person.findUniqueOrThrow({ where: { id } })).email!;
    expect(await findPersonIdByEmail(`  ${email.toUpperCase()} `)).toBe(id);
    expect(await findPersonIdByEmail("   ")).toBeNull();
    expect(await findPersonIdByEmail(`nobody-${randomUUID()}@example.com`)).toBeNull();
  });

  it("describePersonForStaff masks the email, handles missing email/erased/unknown", async () => {
    const id = await person({ email: `zed-${randomUUID().slice(0, 6)}@example.org`, lastActiveAt: new Date() });
    expect(await describePersonForStaff(id)).toMatchObject({ emailMasked: "z***@example.org", erased: false });
    const noMail = await person({ email: null, erasedAt: new Date() });
    expect(await describePersonForStaff(noMail)).toMatchObject({ emailMasked: null, erased: true, lastActiveAt: null });
    expect(await describePersonForStaff(randomUUID())).toBeNull();
  });

  it("getOwnContacts returns contacts, null when unknown or erased", async () => {
    const id = await person({ phone: `+9190${Math.floor(10_000_000 + Math.random() * 89_999_999)}` });
    expect(await getOwnContacts(id)).toMatchObject({ phone: expect.stringContaining("+9190") });
    expect(await getOwnContacts(randomUUID())).toBeNull();
    const erased = await person({ erasedAt: new Date() });
    expect(await getOwnContacts(erased)).toBeNull();
  });
});
