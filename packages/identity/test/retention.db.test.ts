import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { purgeErasedPersonResiduals, purgeExpiredAuthSessions } from "../src";

const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day);
const tag = randomUUID().slice(0, 8);
const personIds: string[] = [];

const person = async (erasedDaysAgo?: number) => {
  const p = await prisma.person.create({ data: { email: `ret-${tag}-${randomUUID().slice(0, 5)}@example.test`, erasedAt: erasedDaysAgo ? ago(erasedDaysAgo) : null } });
  personIds.push(p.id);
  return p.id;
};
const session = (personId: string, o: { expires: number; revoked?: number }) =>
  prisma.authSession.create({ data: { personId, refreshTokenHash: `h-${randomUUID()}`, expiresAt: ago(o.expires), revokedAt: o.revoked ? ago(o.revoked) : null } });

afterAll(async () => {
  await prisma.consent.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.authSession.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("identity retention", () => {
  it("purges expired/revoked sessions past the cutoff only, keeps consents", async () => {
    const p = await person();
    const expiredOld = await session(p, { expires: 500 });
    const revokedOld = await session(p, { expires: -30, revoked: 500 });
    const live = await session(p, { expires: -30 });
    const recentExpired = await session(p, { expires: 5 });
    await prisma.consent.create({ data: { personId: p, purpose: "matching", granted: true, source: "test" } });
    const cutoff = ago(400);

    expect(await purgeExpiredAuthSessions(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(await prisma.authSession.count({ where: { id: expiredOld.id } })).toBe(1);

    expect(await purgeExpiredAuthSessions(cutoff)).toBeGreaterThanOrEqual(2);
    expect(await prisma.authSession.count({ where: { id: { in: [expiredOld.id, revokedOld.id] } } })).toBe(0);
    expect(await prisma.authSession.count({ where: { id: { in: [live.id, recentExpired.id] } } })).toBe(2);
    expect(await prisma.consent.count({ where: { personId: p } })).toBe(1);
    await purgeExpiredAuthSessions(cutoff); // idempotent
    expect(await prisma.authSession.count({ where: { id: { in: [live.id, recentExpired.id] } } })).toBe(2);
  });

  it("purges residual sessions of persons erased before the cutoff", async () => {
    const erasedOld = await person(500);
    const erasedRecent = await person(2);
    const active = await person();
    const [a, b, c] = await Promise.all([erasedOld, erasedRecent, active].map((id) => session(id, { expires: -30 })));
    const cutoff = ago(400);
    expect(await purgeErasedPersonResiduals(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await purgeErasedPersonResiduals(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await prisma.authSession.count({ where: { id: a!.id } })).toBe(0);
    expect(await prisma.authSession.count({ where: { id: { in: [b!.id, c!.id] } } })).toBe(2);
  });
});
