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

it("an upheld offer-honour report lowers trust once; a dismissed one is ignored", async () => {
  const person = await prisma.person.create({ data: { email: `t-${randomUUID()}@example.test` } });
  people.push(person.id);
  const { businessId } = await createBusiness(person.id, { name: "Offer Mfg", isSeller: true });
  ids.push(businessId);
  await redis.del(`trust:${businessId}`);
  await recomputeTrust(businessId);
  const before = (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore;

  const base = { version: 1, aggregateType: "OfferHonourReport", aggregateId: "r", occurredAt: new Date().toISOString() } as const;
  const dismissedId = Math.floor(Math.random() * 1e12);
  await trustHandlers.OfferHonourDecided!({ ...base, id: dismissedId, type: "OfferHonourDecided", payload: { reportId: "r1", offerId: "o", sellerBusinessId: businessId, upheld: false } });
  expect(await redis.hget(`trust:${businessId}`, "offersBroken")).toBeNull();

  const id = dismissedId + 1;
  const ev = { ...base, id, type: "OfferHonourDecided", payload: { reportId: "r2", offerId: "o", sellerBusinessId: businessId, upheld: true } } as const;
  await trustHandlers.OfferHonourDecided!(ev);
  await trustHandlers.OfferHonourDecided!(ev);
  expect(await redis.hget(`trust:${businessId}`, "offersBroken")).toBe("1");
  expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore).toBeLessThan(before);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: businessId } });
  await redis.del(`trust:ev:${id}`);
});

it("a dispute resolved against a business counts as lost once; no-fault outcomes are ignored", async () => {
  const person = await prisma.person.create({ data: { email: `t-${randomUUID()}@example.test` } });
  people.push(person.id);
  const { businessId } = await createBusiness(person.id, { name: "Dispute Mfg", isSeller: true });
  ids.push(businessId);
  await redis.del(`trust:${businessId}`);
  await recomputeTrust(businessId);
  const before = (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore;
  const base = { version: 1, aggregateType: "Dispute", aggregateId: "d", occurredAt: new Date().toISOString(), type: "DisputeResolved" } as const;
  const payload = { disputeId: "d", orderId: "o", outcome: "buyer_favour", refundPaise: 100, releasePaise: 0, decidedBy: "staff" } as const;
  const noFault = Math.floor(Math.random() * 1e12);
  await trustHandlers.DisputeResolved!({ ...base, id: noFault, payload: { ...payload, outcome: "withdrawn", faultBusinessId: null } });
  expect(await redis.hget(`trust:${businessId}`, "disputesLost")).toBeNull();
  const ev = { ...base, id: noFault + 1, payload: { ...payload, faultBusinessId: businessId } };
  await trustHandlers.DisputeResolved!(ev);
  await trustHandlers.DisputeResolved!(ev);
  expect(await redis.hget(`trust:${businessId}`, "disputesLost")).toBe("1");
  expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore).toBeLessThan(before);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: businessId } });
  await redis.del(`trust:ev:${noFault + 1}`);
});

it("seller-initiated lead refunds are counted once (security audit M2); platform-decided refunds are not", async () => {
  const person = await prisma.person.create({ data: { email: `t-${randomUUID()}@example.test` } });
  people.push(person.id);
  const { businessId } = await createBusiness(person.id, { name: "Refund Mfg", isSeller: true });
  ids.push(businessId);
  await redis.del(`trust:${businessId}`);
  const base = { version: 1, aggregateType: "enquiry", aggregateId: "e", occurredAt: new Date().toISOString() } as const;
  const rejectedId = Math.floor(Math.random() * 1e12);
  await trustHandlers.LeadRefunded!({ ...base, id: rejectedId, type: "LeadRefunded", payload: { enquiryId: "e", matchId: "m", sellerBusinessId: businessId, reason: "enquiry_rejected" } });
  expect(await redis.hget(`trust:${businessId}`, "refundsClaimed")).toBeNull();
  const id = rejectedId + 1;
  const ev = { ...base, id, type: "LeadRefunded", payload: { enquiryId: "e", matchId: "m", sellerBusinessId: businessId, reason: "buyer_fake" } } as const;
  await trustHandlers.LeadRefunded!(ev);
  await trustHandlers.LeadRefunded!(ev);
  expect(await redis.hget(`trust:${businessId}`, "refundsClaimed")).toBe("1");
  await prisma.domainEvent.deleteMany({ where: { aggregateId: businessId } });
  await redis.del(`trust:ev:${id}`);
});
