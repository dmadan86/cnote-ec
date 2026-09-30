import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { purgeAbandonedCaptures } from "../src";

const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
const ids: string[] = [];
const mk = async (status: "started" | "otp_sent" | "abandoned" | "verified" | "converted", updatedDays: number) => {
  const c = await prisma.leadCapture.create({ data: { visitorId: `ret_${randomUUID()}`, trigger: "t", unlock: "u", status, updatedAt: ago(updatedDays) } });
  ids.push(c.id);
  return c.id;
};
afterAll(() => prisma.leadCapture.deleteMany({ where: { id: { in: ids } } }));

describe("purgeAbandonedCaptures", () => {
  it("deletes only stale incomplete captures", async () => {
    const [a, b, c, verified, converted, fresh] = [await mk("abandoned", 500), await mk("started", 500), await mk("otp_sent", 500), await mk("verified", 500), await mk("converted", 500), await mk("abandoned", 1)];
    const cutoff = ago(400);
    expect(await purgeAbandonedCaptures(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(3);
    expect(await prisma.leadCapture.count({ where: { id: a } })).toBe(1);
    expect(await purgeAbandonedCaptures(cutoff)).toBeGreaterThanOrEqual(3);
    expect(await prisma.leadCapture.count({ where: { id: { in: [a, b, c] } } })).toBe(0);
    expect(await prisma.leadCapture.count({ where: { id: { in: [verified, converted, fresh] } } })).toBe(3);
    await purgeAbandonedCaptures(cutoff);
  });
});
