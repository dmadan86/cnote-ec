import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { findOrCreatePersonByVerifiedPhone } from "../src";

const phone = `+9190${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
afterAll(async () => {
  const p = await prisma.person.findUnique({ where: { phone } });
  if (p) {
    await prisma.domainEvent.deleteMany({ where: { aggregateId: p.id } });
    await prisma.person.delete({ where: { id: p.id } });
  }
});

describe("findOrCreatePersonByVerifiedPhone", () => {
  it("creates a phone-verified person once and returns the same one after", async () => {
    const a = await findOrCreatePersonByVerifiedPhone(phone);
    expect(a.isNew).toBe(true);
    const row = await prisma.person.findUniqueOrThrow({ where: { id: a.personId } });
    expect(row.phoneVerifiedAt).not.toBeNull();
    const b = await findOrCreatePersonByVerifiedPhone(phone);
    expect(b).toEqual({ personId: a.personId, isNew: false });
  });
  it("verifies an existing unverified person and refuses erased ones", async () => {
    const p = await prisma.person.findUniqueOrThrow({ where: { phone } });
    await prisma.person.update({ where: { id: p.id }, data: { phoneVerifiedAt: null } });
    await findOrCreatePersonByVerifiedPhone(phone);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: p.id } })).phoneVerifiedAt).not.toBeNull();
    await prisma.person.update({ where: { id: p.id }, data: { erasedAt: new Date() } });
    await expect(findOrCreatePersonByVerifiedPhone(phone)).rejects.toThrow(/no longer available/);
    await prisma.person.update({ where: { id: p.id }, data: { erasedAt: null } });
  });
  it("survives a concurrent create race", async () => {
    const p2 = `+9191${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const [x, y] = await Promise.all([findOrCreatePersonByVerifiedPhone(p2), findOrCreatePersonByVerifiedPhone(p2)]);
    expect(x.personId).toBe(y.personId);
    const p = await prisma.person.findUniqueOrThrow({ where: { phone: p2 } });
    await prisma.domainEvent.deleteMany({ where: { aggregateId: p.id } });
    await prisma.person.delete({ where: { id: p.id } });
  });
});
