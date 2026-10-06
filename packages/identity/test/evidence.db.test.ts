import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { getVerificationEvidence } from "../src";

const tag = `ev-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];

afterAll(async () => {
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("getVerificationEvidence (db)", () => {
  it("derives checks from verification records and the owner's verified phone, masks the GSTIN, ignores erased people", async () => {
    const gstin = `27${Math.random().toString(36).slice(2, 11).toUpperCase().padEnd(9, "X")}F1Z5`;
    const biz = await prisma.business.create({
      data: { name: `${tag} Traders Pvt Ltd`, isSeller: true, gstin, udyam: "UDYAM-MH-01-0000001", verificationTier: 1, badgeActive: true },
    });
    const bare = await prisma.business.create({ data: { name: `${tag} Bare`, isSeller: true } });
    bizIds.push(biz.id, bare.id);
    const owner = await prisma.person.create({ data: { name: tag, phoneVerifiedAt: new Date("2024-01-02T00:00:00Z") } });
    const erased = await prisma.person.create({ data: { name: tag, phoneVerifiedAt: new Date("2023-01-02T00:00:00Z"), erasedAt: new Date() } });
    personIds.push(owner.id, erased.id);
    await prisma.businessMember.createMany({ data: [{ businessId: biz.id, personId: owner.id }, { businessId: biz.id, personId: erased.id }] });
    await prisma.verificationRecord.createMany({
      data: [
        { businessId: biz.id, tier: 1, kind: "gstin", status: "passed", provider: "t", details: { legalName: `${tag} TRADERS PRIVATE LIMITED` }, createdAt: new Date("2024-02-01T00:00:00Z") },
        { businessId: biz.id, tier: 1, kind: "udyam", status: "passed", provider: "t", details: {}, createdAt: new Date("2024-02-01T00:00:01Z") },
        { businessId: biz.id, tier: 3, kind: "phone_otp", status: "passed", provider: "t", details: {} },
      ],
    });

    const m = await getVerificationEvidence([biz.id, bare.id]);
    const e = m.get(biz.id)!;
    const by = (k: string) => e.checks.find((c) => c.key === k)!;
    expect(by("phone")).toMatchObject({ passed: true, at: "2024-01-02T00:00:00.000Z" });
    expect(by("gstin")).toMatchObject({ passed: true, at: "2024-02-01T00:00:00.000Z" });
    expect(by("gstin_name_match").passed).toBe(true);
    expect(by("udyam").passed).toBe(true);
    expect(by("documents").passed).toBe(false);
    expect(by("audit").passed).toBe(false);
    expect(e.gstinMasked).toMatch(/^27•{9}.{4}$/);
    expect(JSON.stringify(e)).not.toContain("UDYAM");

    const b = m.get(bare.id)!;
    expect(b.checks.every((c) => !c.passed)).toBe(true);
    expect(b.gstinMasked).toBeNull();
  });
  it("uses the earliest phone verification among several verified members", async () => {
    const biz = await prisma.business.create({ data: { name: `${tag} Multi`, isSeller: true } });
    bizIds.push(biz.id);
    const a = await prisma.person.create({ data: { name: tag, phoneVerifiedAt: new Date("2024-05-01T00:00:00Z") } });
    const b = await prisma.person.create({ data: { name: tag, phoneVerifiedAt: new Date("2022-05-01T00:00:00Z") } });
    const c = await prisma.person.create({ data: { name: tag, phoneVerifiedAt: new Date("2023-05-01T00:00:00Z") } });
    personIds.push(a.id, b.id, c.id);
    await prisma.businessMember.createMany({ data: [a, b, c].map((p) => ({ businessId: biz.id, personId: p.id })) });
    const e = (await getVerificationEvidence([biz.id])).get(biz.id)!;
    expect(e.checks.find((k) => k.key === "phone")).toMatchObject({ passed: true, at: "2022-05-01T00:00:00.000Z" });
  });
});
