import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import { getLastActiveAt, isInactivityEligible, listInactiveAccounts, touchLastActive } from "../src";

const DAY = 86_400_000;
const mk = (o: { ageDays: number; lastActiveDays?: number | null; email?: string | null }) => {
  const id = randomUUID();
  return prisma.person
    .create({ data: { id, email: o.email === null ? null : `la-${id.slice(0, 8)}@example.com`, createdAt: new Date(Date.now() - o.ageDays * DAY), lastActiveAt: o.lastActiveDays == null ? null : new Date(Date.now() - o.lastActiveDays * DAY) } })
    .then(() => id);
};

describe("durable last-activity marker", () => {
  it("touchLastActive sets it, and writes at most once a day", async () => {
    const id = await mk({ ageDays: 100 });
    const t0 = new Date();
    await touchLastActive(id, t0);
    const first = (await prisma.person.findUniqueOrThrow({ where: { id } })).lastActiveAt!;
    expect(first.getTime()).toBe(t0.getTime());
    await touchLastActive(id, new Date(t0.getTime() + 3_600_000));
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).lastActiveAt!.getTime()).toBe(t0.getTime());
    await touchLastActive(id, new Date(t0.getTime() + 2 * DAY));
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).lastActiveAt!.getTime()).toBe(t0.getTime() + 2 * DAY);
  });
  it("getLastActiveAt takes the newest of sign-up, marker and session; erased people have none", async () => {
    const id = await mk({ ageDays: 2000, lastActiveDays: 1500 });
    expect(Math.abs((await getLastActiveAt(id))!.getTime() - (Date.now() - 1500 * DAY))).toBeLessThan(5000);
    await prisma.authSession.create({ data: { personId: id, refreshTokenHash: `h-${randomUUID()}`, expiresAt: new Date(Date.now() - DAY), revokedAt: new Date(), lastUsedAt: new Date(Date.now() - 10 * DAY) } });
    expect(Math.abs((await getLastActiveAt(id))!.getTime() - (Date.now() - 10 * DAY))).toBeLessThan(5000);
    await prisma.person.update({ where: { id }, data: { erasedAt: new Date() } });
    expect(await getLastActiveAt(id)).toBeNull();
    expect(await getLastActiveAt(randomUUID())).toBeNull();
  });
  it("listInactiveAccounts / isInactivityEligible only offer eligible, long-inactive people", async () => {
    const old = await mk({ ageDays: 2000, lastActiveDays: 1500 });
    const recent = await mk({ ageDays: 2000, lastActiveDays: 5 });
    const noMail = await mk({ ageDays: 2000, email: null });
    const before = new Date(Date.now() - 1000 * DAY);
    const ids = (await listInactiveAccounts(before, 500)).map((a) => a.personId);
    expect(ids).toContain(old);
    expect(ids).not.toContain(recent);
    expect(ids).not.toContain(noMail);
    expect(await isInactivityEligible(old)).toBe(true);
    expect(await isInactivityEligible(noMail)).toBe(false);
  });
});
