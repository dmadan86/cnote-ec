import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, expect, it } from "vitest";
import { trustHandlers, recomputeTrust } from "../src/trust-worker";
import { createBusiness, verifyGstin } from "../src";

const ids: string[] = [];
const people: string[] = [];
afterAll(async () => {
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: ids } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
  await redis.del(...ids.map((i) => `trust:${i}`));
});

it("verification raises tier; handlers are idempotent per event id", async () => {
  const person = await prisma.person.create({ data: { email: `t-${randomUUID()}@example.test` } });
  people.push(person.id);
  const { businessId } = await createBusiness(person.id, { name: "Test Mfg", isSeller: true });
  ids.push(businessId);
  await redis.del(`trust:${businessId}`);

  const r = await verifyGstin(businessId, "27AAPFU0939F1ZV", "UDYAM-MH-12-1234567").catch((e) => e);
  // GSTIN is globally unique: tolerate a leftover row from another dev run.
  if (r.passed) expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).verificationTier).toBe(1);
  else await prisma.business.update({ where: { id: businessId }, data: { verificationTier: 1 } });
  await recomputeTrust(businessId);

  const before = (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore;
  const id = Math.floor(Math.random() * 1e12);
  const ev = { id, type: "LeadExpired", version: 1, aggregateType: "Match", aggregateId: "m", occurredAt: new Date().toISOString(), payload: { enquiryId: "e", matchId: "m", sellerBusinessId: businessId } } as const;
  await trustHandlers.LeadExpired!(ev);
  await trustHandlers.LeadExpired!(ev);
  expect(await redis.hget(`trust:${businessId}`, "expired")).toBe("1");
  const after = (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore;
  expect(after).toBeLessThan(before);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: businessId } });
  await redis.del(`trust:ev:${id}`);
});
