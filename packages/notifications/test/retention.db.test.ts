import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { purgeReadNotifications } from "../src";

const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
const personId = randomUUID();
const mk = (readDays: number | null) =>
  prisma.notification.create({ data: { personId, kind: "test.kind", title: "t", body: "b", app: "web", readAt: readDays === null ? null : ago(readDays), createdAt: ago(600) } }).then((n) => n.id);
afterAll(() => prisma.notification.deleteMany({ where: { personId } }));

describe("purgeReadNotifications", () => {
  it("deletes read notifications older than the cutoff, keeps unread and recent", async () => {
    const [oldRead, unread, recent] = [await mk(500), await mk(null), await mk(1)];
    const cutoff = ago(400);
    expect(await purgeReadNotifications(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { id: oldRead } })).toBe(1);
    expect(await purgeReadNotifications(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { id: oldRead } })).toBe(0);
    expect(await prisma.notification.count({ where: { id: { in: [unread, recent] } } })).toBe(2);
    await purgeReadNotifications(cutoff);
  });
});
