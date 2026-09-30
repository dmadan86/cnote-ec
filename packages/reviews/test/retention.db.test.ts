import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { purgeRejectedUgc } from "../src";

const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
const listingId = randomUUID();
const sellerBusinessId = randomUUID();
const review = (status: "approved" | "rejected", days: number) =>
  prisma.productReview.create({ data: { listingId, sellerBusinessId, authorPersonId: randomUUID(), rating: 3, body: "b", status, moderatedAt: ago(days) } }).then((r) => r.id);
const comment = (status: "approved" | "rejected", days: number, parentId?: string) =>
  prisma.productComment.create({ data: { listingId, authorPersonId: randomUUID(), body: "c", status, moderatedAt: ago(days), parentId } }).then((r) => r.id);

afterAll(async () => {
  await prisma.productComment.deleteMany({ where: { listingId, parentId: { not: null } } });
  await prisma.productComment.deleteMany({ where: { listingId } });
  await prisma.productReview.deleteMany({ where: { listingId } });
});

describe("purgeRejectedUgc", () => {
  it("deletes old rejected reviews/comments (and their reactions); keeps approved, recent and parents with replies until replies go", async () => {
    const oldRej = await review("rejected", 500);
    const recentRej = await review("rejected", 5);
    const approvedOld = await review("approved", 500);
    await prisma.ugcReaction.create({ data: { subjectType: "review", subjectId: oldRej, personId: randomUUID(), kind: "report" } });
    const parent = await comment("rejected", 500);
    const child = await comment("rejected", 500, parent);
    const okComment = await comment("approved", 500);
    const cutoff = ago(400);

    expect(await purgeRejectedUgc(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(await prisma.productReview.count({ where: { id: oldRej } })).toBe(1);

    expect(await purgeRejectedUgc(cutoff)).toBeGreaterThanOrEqual(2); // oldRej + child (parent still has a reply)
    expect(await prisma.productReview.count({ where: { id: oldRej } })).toBe(0);
    expect(await prisma.ugcReaction.count({ where: { subjectId: oldRej } })).toBe(0);
    expect(await prisma.productComment.count({ where: { id: child } })).toBe(0);
    expect(await prisma.productComment.count({ where: { id: parent } })).toBe(1);
    expect(await purgeRejectedUgc(cutoff)).toBeGreaterThanOrEqual(1); // now the parent
    expect(await prisma.productComment.count({ where: { id: parent } })).toBe(0);
    expect(await prisma.productReview.count({ where: { id: { in: [recentRej, approvedOld] } } })).toBe(2);
    expect(await prisma.productComment.count({ where: { id: okComment } })).toBe(1);
    expect(await purgeRejectedUgc(cutoff)).toBeGreaterThanOrEqual(0);
  });
});
