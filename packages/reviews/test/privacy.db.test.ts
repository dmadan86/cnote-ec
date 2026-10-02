import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

const personId = randomUUID();
const listingId = randomUUID();
const sellerBusinessId = randomUUID();
let made = false;
afterAll(async () => {
  if (made) {
    await prisma.productAnswer.deleteMany({ where: { listingId } });
    await prisma.productQuestion.deleteMany({ where: { listingId } });
    await prisma.productComment.deleteMany({ where: { listingId } });
    await prisma.productReview.deleteMany({ where: { listingId } });
    await prisma.ugcReaction.deleteMany({ where: { personId } });
  }
});

describe("exportPersonalData (DPDP access right)", () => {
  it("exports the person's reviews, comments, questions and reactions (not moderation internals)", async () => {
    made = true;
    await prisma.productReview.create({ data: { listingId, sellerBusinessId, authorPersonId: personId, rating: 4, title: "Good", body: "Solid boxes", moderatedBy: randomUUID() } });
    await prisma.productComment.create({ data: { listingId, authorPersonId: personId, body: "Nice" } });
    await prisma.productQuestion.create({ data: { listingId, sellerBusinessId, authorPersonId: personId, body: "MOQ?" } });
    await prisma.ugcReaction.create({ data: { subjectType: "review", subjectId: randomUUID(), personId, kind: "helpful" } });
    const out = (await exportPersonalData(personId)) as Record<string, { items: any[] }>;
    expect(out.reviews!.items[0]).toMatchObject({ rating: 4, body: "Solid boxes" });
    expect(out.reviews!.items[0]).not.toHaveProperty("moderatedBy");
    expect(out.comments!.items[0]).toMatchObject({ body: "Nice" });
    expect(out.questions!.items[0]).toMatchObject({ body: "MOQ?" });
    expect(out.reactions!.items[0]).toMatchObject({ kind: "helpful" });
    expect(out.answers!.items).toEqual([]);
  });
  it("is empty for an unknown person", async () => {
    const out = (await exportPersonalData(randomUUID())) as Record<string, { items: unknown[] }>;
    for (const k of ["reviews", "comments", "questions", "answers", "reactions"]) expect(out[k]!.items).toEqual([]);
  });
});
