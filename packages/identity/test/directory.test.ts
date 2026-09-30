import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPersonBusinesses,
  getPersonByEmail,
  getPersonContact,
  getPersonSummaries,
  getPersonVerification,
  isBusinessMember,
  isPersonErased,
  listBusinessMembers,
  maskEmail,
  setConsent,
} from "../src";

// DPDP (ADR-010): other modules read people only through these getters, so erased persons and
// consent-gated fields must never leak through them.
const people: string[] = [];
const businesses: string[] = [];

async function person(data: { email?: string; phone?: string; name?: string; phoneVerifiedAt?: Date; emailVerifiedAt?: Date; erasedAt?: Date } = {}) {
  const p = await prisma.person.create({ data: { email: data.email ?? `dir-${randomUUID()}@example.test`, ...data } });
  people.push(p.id);
  return p;
}

async function business(name: string, members: { personId: string; role: "owner" | "staff" }[], extra: { isSeller?: boolean } = {}) {
  const b = await prisma.business.create({ data: { name, ...extra } });
  businesses.push(b.id);
  for (const m of members) await prisma.businessMember.create({ data: { businessId: b.id, personId: m.personId, role: m.role } });
  return b;
}

afterAll(async () => {
  await prisma.businessMember.deleteMany({ where: { businessId: { in: businesses } } });
  await prisma.business.deleteMany({ where: { id: { in: businesses } } });
  await prisma.consent.deleteMany({ where: { personId: { in: people } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
});

const phone = () => `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

describe("business membership", () => {
  it("lists members (optionally owners only) and answers membership", async () => {
    const owner = await person();
    const staff = await person();
    const outsider = await person();
    const b = await business(`dir-b-${randomUUID()}`, [
      { personId: owner.id, role: "owner" },
      { personId: staff.id, role: "staff" },
    ]);
    expect((await listBusinessMembers(b.id)).map((m) => m.personId).sort()).toEqual([owner.id, staff.id].sort());
    expect(await listBusinessMembers(b.id, { ownersOnly: true })).toEqual([{ personId: owner.id, role: "owner" }]);
    expect(await isBusinessMember(staff.id, b.id)).toBe(true);
    expect(await isBusinessMember(outsider.id, b.id)).toBe(false);
  });

  it("returns a person's businesses oldest first with their role and flags", async () => {
    const p = await person();
    const first = await business(`dir-first-${randomUUID()}`, [{ personId: p.id, role: "owner" }], { isSeller: true });
    const second = await business(`dir-second-${randomUUID()}`, [{ personId: p.id, role: "staff" }]);
    const list = await getPersonBusinesses(p.id);
    expect(list.map((b) => b.businessId)).toEqual([first.id, second.id]);
    expect(list[0]).toMatchObject({ role: "owner", isSeller: true, verificationTier: 0 });
    expect(list[1]).toMatchObject({ role: "staff", isSeller: false });
    expect(await getPersonBusinesses(randomUUID())).toEqual([]);
  });
});

describe("getPersonContact", () => {
  it("withholds the phone from other parties unless counterparty_sharing is granted", async () => {
    const p = await person({ phone: phone(), name: "Asha" });
    expect(await getPersonContact(p.id)).toEqual({ email: p.email, phone: null, name: "Asha" });
    await setConsent(p.id, "counterparty_sharing", true, "web");
    expect((await getPersonContact(p.id))?.phone).toBe(p.phone);
  });

  it("always includes the phone for messages to the person themselves", async () => {
    const p = await person({ phone: phone() });
    expect((await getPersonContact(p.id, { self: true }))?.phone).toBe(p.phone);
  });

  it("returns null for unknown or erased persons", async () => {
    const erased = await person({ phone: phone(), erasedAt: new Date() });
    expect(await getPersonContact(erased.id, { self: true })).toBeNull();
    expect(await getPersonContact(randomUUID())).toBeNull();
  });
});

describe("getPersonByEmail", () => {
  it("matches case-insensitively and never returns erased persons", async () => {
    const email = `dir-${randomUUID()}@example.test`;
    const p = await person({ email, name: "Ravi" });
    expect(await getPersonByEmail(email.toUpperCase())).toEqual({ id: p.id, name: "Ravi", email });
    const gone = await person({ erasedAt: new Date() });
    expect(await getPersonByEmail(gone.email!)).toBeNull();
    expect(await getPersonByEmail(`nobody-${randomUUID()}@example.test`)).toBeNull();
  });
});

describe("getPersonSummaries", () => {
  it("masks emails by default, unmasks for staff, and blanks erased persons", async () => {
    const a = await person({ email: `dsummary-${randomUUID()}@example.test`, name: "A" });
    const e = await person({ name: "Erased", erasedAt: new Date() });
    const masked = await getPersonSummaries([a.id, e.id, a.id]);
    expect(masked.size).toBe(2);
    expect(masked.get(a.id)).toEqual({ id: a.id, name: "A", email: `d***${a.email!.slice(a.email!.indexOf("@"))}` });
    expect(masked.get(e.id)).toEqual({ id: e.id, name: null, email: null });
    expect((await getPersonSummaries([a.id], { unmasked: true })).get(a.id)?.email).toBe(a.email);
    expect(await getPersonSummaries([])).toEqual(new Map());
  });

  it("maskEmail handles missing and malformed addresses", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("@nolocal.in")).toBe("***");
    expect(maskEmail("x@y.in")).toBe("x***@y.in");
  });
});

describe("erasure and verification flags", () => {
  it("isPersonErased is true for erased and unknown persons", async () => {
    const live = await person();
    const erased = await person({ erasedAt: new Date() });
    expect(await isPersonErased(live.id)).toBe(false);
    expect(await isPersonErased(erased.id)).toBe(true);
    expect(await isPersonErased(randomUUID())).toBe(true);
  });

  it("getPersonVerification reports verified phone/email and never exposes an erased person's phone", async () => {
    const v = await person({ phone: phone(), phoneVerifiedAt: new Date(), emailVerifiedAt: new Date() });
    expect(await getPersonVerification(v.id)).toEqual({ phone: v.phone, phoneVerified: true, emailVerified: true, erased: false });
    const u = await person({ phone: phone() });
    expect(await getPersonVerification(u.id)).toMatchObject({ phoneVerified: false, emailVerified: false });
    const erased = await person({ phone: phone(), phoneVerifiedAt: new Date(), erasedAt: new Date() });
    expect(await getPersonVerification(erased.id)).toEqual({ phone: null, phoneVerified: false, emailVerified: false, erased: true });
  });

  it("getPersonVerification rejects malformed ids without querying and returns null for unknown ones", async () => {
    expect(await getPersonVerification("not-a-uuid")).toBeNull();
    expect(await getPersonVerification(randomUUID())).toBeNull();
  });
});
