import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listings: new Map<string, { id: string; sellerBusinessId: string; status: string }>(),
  verdict: "allow" as "allow" | "review" | "block",
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async () => ({ verdict: state.verdict, flags: [], reason: null, decisionId: randomUUID(), confidence: 1, needsReview: false }),
}));
vi.mock("@cnote/catalogue", () => ({
  getListing: async (id: string) => state.listings.get(id) ?? null,
  listSellerListings: async (biz: string) => [...state.listings.values()].filter((l) => l.sellerBusinessId === biz),
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => new Map(), getPersonVerification: async () => ({ phone: null, phoneVerified: false, emailVerified: true, erased: false, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }) }));
vi.mock("@cnote/enquiry", () => ({}));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => true }));

import {
  TOMBSTONE_PERSON_ID, getMyReview, getRatingSummary, listApprovedComments, listApprovedReviews, listMyPendingComments, listModerationQueue,
  listSellerUgc, moderate, react, replyToReview, submitComment, submitReview, worker,
} from "../src";

const tag = `rev-test-${Date.now()}`;
const sellerBiz = randomUUID();
const staffId = randomUUID();
const people = Array.from({ length: 5 }, () => randomUUID());
const listingIds: string[] = [];
const newListing = () => {
  const id = randomUUID();
  state.listings.set(id, { id, sellerBusinessId: sellerBiz, status: "published" });
  listingIds.push(id);
  return id;
};
const as = (i: number) => ({ personId: people[i]!, businessId: null });
const good = { rating: 4, title: "Solid", body: "Works well for our factory floor, delivery was on time." };

beforeAll(() => void 0);
beforeEach(() => void (state.verdict = "allow"));
afterAll(async () => {
  const revs = (await prisma.productReview.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((r) => r.id);
  const coms = (await prisma.productComment.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((r) => r.id);
  await prisma.ugcReaction.deleteMany({ where: { subjectId: { in: [...revs, ...coms] } } });
  await prisma.productComment.deleteMany({ where: { listingId: { in: listingIds }, parentId: { not: null } } });
  await prisma.productComment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.productReview.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingRatingSummary.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...revs, ...coms]})`;
  await prisma.$disconnect();
});

const eventsFor = (id: string) => prisma.domainEvent.findMany({ where: { aggregateId: id }, orderBy: { id: "asc" } });

describe("submission validation", () => {
  it("rejects bad rating, short body, PII, long title", async () => {
    const l = newListing();
    await expect(submitReview(as(0), l, { ...good, rating: 0 })).rejects.toThrow();
    await expect(submitReview(as(0), l, { ...good, rating: 4.5 })).rejects.toThrow();
    await expect(submitReview(as(0), l, { ...good, body: "too short" })).rejects.toThrow();
    await expect(submitReview(as(0), l, { ...good, body: "Call me on 9876543210 for a discount please" })).rejects.toThrow(/phone numbers/);
    await expect(submitReview(as(0), l, { ...good, body: "mail me at a.b@example.com for details" })).rejects.toThrow(/email/);
    await expect(submitReview(as(0), l, { ...good, title: "x".repeat(121) })).rejects.toThrow();
    await expect(submitComment(as(0), l, { body: "x" })).rejects.toThrow();
    await expect(submitComment(as(0), l, { body: "x".repeat(1001) })).rejects.toThrow();
    expect(await prisma.productReview.count({ where: { listingId: l } })).toBe(0);
  });
  it("unavailable listings 404", async () => {
    await expect(submitReview(as(0), randomUUID(), good)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("reviews", () => {
  it("starts pending, emits ReviewSubmitted, is not public, is visible to its author as awaiting", async () => {
    const l = newListing();
    const mine = await submitReview(as(0), l, good);
    expect(mine.status).toBe("pending");
    expect((await listApprovedReviews(l)).items).toHaveLength(0);
    expect((await getMyReview(l, people[0]!))?.status).toBe("pending");
    expect((await eventsFor(mine.id)).map((e) => e.type)).toEqual(["ReviewSubmitted"]);
  });

  it("AI review/block verdicts flag (never approve); allow is pending", async () => {
    for (const [verdict, i] of [["review", 1], ["block", 2]] as const) {
      const l = newListing();
      state.verdict = verdict;
      await submitReview(as(i), l, good);
      const row = await prisma.productReview.findFirstOrThrow({ where: { listingId: l } });
      expect(row.status).toBe("flagged");
      expect(row.aiVerdict).toBe(verdict);
      expect((await getMyReview(l, people[i]!))?.status).toBe("pending"); // authors never see "flagged"
    }
  });

  it("forbids reviewing your own listing (any member of the seller business)", async () => {
    const l = newListing();
    await expect(submitReview({ personId: people[3]!, businessId: sellerBiz }, l, good)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("one per person: edit updates in place and resets to pending; aggregate only counts approved", async () => {
    const l = newListing();
    const r1 = await submitReview(as(0), l, { ...good, rating: 5 });
    const r2 = await submitReview(as(1), l, { ...good, rating: 2 });
    expect(await getRatingSummary(l)).toMatchObject({ count: 0, average: 0 });

    await moderate("review", r1.id, "approved", null, staffId);
    expect(await getRatingSummary(l)).toMatchObject({ count: 1, average: 5, histogram: [0, 0, 0, 0, 1] });
    await moderate("review", r2.id, "approved", null, staffId);
    expect(await getRatingSummary(l)).toMatchObject({ count: 2, average: 3.5, histogram: [0, 1, 0, 0, 1] });

    // edit an approved review: same row, pending again, leaves the aggregate until re-approved
    const edited = await submitReview(as(0), l, { ...good, rating: 1, body: "Changed my mind after a month of use." });
    expect(edited.id).toBe(r1.id);
    expect(edited.status).toBe("pending");
    expect(await prisma.productReview.count({ where: { listingId: l } })).toBe(2);
    expect(await getRatingSummary(l)).toMatchObject({ count: 1, average: 2, histogram: [0, 1, 0, 0, 0] });
    expect((await listApprovedReviews(l)).items.map((r) => r.id)).toEqual([r2.id]);

    await moderate("review", r1.id, "approved", null, staffId);
    expect(await getRatingSummary(l)).toMatchObject({ count: 2, average: 1.5 });
    const rej = await moderate("review", r2.id, "rejected", "Not about this product", staffId);
    expect(rej.before.status).toBe("approved");
    expect(rej.after).toMatchObject({ status: "rejected", moderationNote: "Not about this product" });
    expect(await getRatingSummary(l)).toMatchObject({ count: 1, average: 1 });
    expect(await getMyReview(l, people[1]!)).toMatchObject({ status: "rejected", moderationNote: "Not about this product" });
  });
});

describe("moderation", () => {
  it("requires a note to reject; emits ReviewModerated/CommentModerated; idempotent; queue lists open items", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good);
    const c = await submitComment(as(1), l, { body: "Does it come in 50 kg bags?" });
    await expect(moderate("review", r.id, "rejected", "  ", staffId)).rejects.toMatchObject({ code: "validation" });

    const q = await listModerationQueue({ kind: "review", status: "pending", limit: 100 });
    expect(q.items.some((i) => i.id === r.id && i.listingId === l)).toBe(true);
    expect((await listModerationQueue({ kind: "comment", limit: 100 })).items.some((i) => i.id === c.id)).toBe(true);

    const res = await moderate("review", r.id, "approved", null, staffId);
    expect(res.before.status).toBe("pending");
    expect(res.after.status).toBe("approved");
    await moderate("review", r.id, "approved", null, staffId); // repeat: no second event
    await moderate("comment", c.id, "approved", null, staffId);

    expect((await eventsFor(r.id)).map((e) => e.type)).toEqual(["ReviewSubmitted", "ReviewModerated"]);
    const ce = await eventsFor(c.id);
    expect(ce.map((e) => e.type)).toEqual(["CommentSubmitted", "CommentModerated"]);
    expect(ce[1]!.payload).toMatchObject({ status: "approved", moderatedBy: staffId });
    expect((await listModerationQueue({ kind: "review", status: "pending", limit: 100 })).items.some((i) => i.id === r.id)).toBe(false);
  });
});

describe("reactions", () => {
  it("helpful dedupes and counts; report dedupes; 3 reports re-flag an approved review and drop it from the aggregate", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, { ...good, rating: 3 });
    await expect(react(as(1), { subjectType: "review", subjectId: r.id, kind: "helpful" })).rejects.toMatchObject({ code: "not_found" }); // not approved yet
    await moderate("review", r.id, "approved", null, staffId);
    expect(await react(as(1), { subjectType: "review", subjectId: r.id, kind: "helpful" })).toEqual({ changed: true });
    expect(await react(as(1), { subjectType: "review", subjectId: r.id, kind: "helpful" })).toEqual({ changed: false });
    await expect(react(as(0), { subjectType: "review", subjectId: r.id, kind: "helpful" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(react(as(2), { subjectType: "review", subjectId: r.id, kind: "report" })).rejects.toThrow(); // reason required
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } })).helpfulCount).toBe(1);

    const report = (i: number) => react(as(i), { subjectType: "review", subjectId: r.id, kind: "report", reason: "Looks fake" });
    await report(1);
    expect(await report(1)).toEqual({ changed: false });
    await report(2);
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("approved");
    await report(3);
    const row = await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: "flagged", reportCount: 3 });
    expect((await listApprovedReviews(l)).items).toHaveLength(0);
    expect((await getRatingSummary(l)).count).toBe(0);

    await moderate("review", r.id, "approved", null, staffId); // staff re-approve: back, reports reset
    expect((await getRatingSummary(l)).count).toBe(1);
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } })).reportCount).toBe(0);
  });
});

describe("comments, threads and seller replies", () => {
  it("threads: only approved comments/replies are public; sellers reply; others can't", async () => {
    const l = newListing();
    const q = await submitComment(as(0), l, { body: "What is the lead time?" });
    expect((await listMyPendingComments(l, people[0]!)).map((c) => c.status)).toEqual(["pending"]);
    expect(await listApprovedComments(l)).toHaveLength(0);
    await expect(submitComment(as(1), l, { body: "I also want to know", parentId: q.id })).rejects.toMatchObject({ code: "forbidden" });
    const seller = { personId: people[4]!, businessId: sellerBiz };
    await expect(submitComment(seller, l, { body: "Two weeks.", parentId: q.id })).rejects.toMatchObject({ code: "conflict" }); // parent not public
    await moderate("comment", q.id, "approved", null, staffId);
    const a = await submitComment(seller, l, { body: "Two weeks from order.", parentId: q.id });
    expect(a.status).toBe("pending");
    expect((await listApprovedComments(l))[0]!.replies).toHaveLength(0);
    await expect(submitComment(seller, l, { body: "nested", parentId: a.id })).rejects.toBeTruthy();
    await moderate("comment", a.id, "approved", null, staffId);
    const [thread] = await listApprovedComments(l);
    expect(thread!.replies[0]).toMatchObject({ body: "Two weeks from order.", isSeller: true });
    expect((await listSellerUgc(sellerBiz, { kind: "comment", listingId: l })).items[0]).toMatchObject({ id: q.id, needsReply: false });
  });

  it("seller reply to a review is moderated before it shows", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good);
    const seller = { personId: people[4]!, businessId: sellerBiz };
    await expect(replyToReview(seller, r.id, "Thank you!")).rejects.toMatchObject({ code: "not_found" }); // not approved
    await moderate("review", r.id, "approved", null, staffId);
    await expect(replyToReview(as(1), r.id, "Thank you!")).rejects.toMatchObject({ code: "forbidden" });
    await replyToReview(seller, r.id, "Thank you for the feedback!");
    expect((await listApprovedReviews(l)).items[0]!.sellerReply).toBeNull();
    expect((await listModerationQueue({ kind: "reply", limit: 100 })).items.some((i) => i.id === r.id)).toBe(true);
    await moderate("reply", r.id, "approved", null, staffId);
    expect((await listApprovedReviews(l)).items[0]!.sellerReply?.body).toBe("Thank you for the feedback!");
    expect((await listSellerUgc(sellerBiz, { kind: "review", listingId: l })).items[0]).toMatchObject({ needsReply: false });
  });
});

describe("erasure worker", () => {
  it("anonymises approved content, deletes unpublished content and reactions; idempotent", async () => {
    const l1 = newListing();
    const l2 = newListing();
    const approved = await submitReview(as(0), l1, good);
    await submitReview(as(0), l2, good); // stays pending → deleted
    await moderate("review", approved.id, "approved", null, staffId);
    const c = await submitComment(as(0), l1, { body: "Any bulk discount available?" });
    await moderate("comment", c.id, "approved", null, staffId);
    await react(as(0), { subjectType: "review", subjectId: (await submitReview(as(1), l1, good)).id, kind: "helpful" }).catch(() => undefined);

    const erase = worker.handlers.DataErasureRequested!;
    const ev = { id: 1, type: "DataErasureRequested" as const, version: 1, aggregateType: "person", aggregateId: people[0]!, payload: { personId: people[0]! }, occurredAt: new Date().toISOString() };
    await erase(ev);
    await erase(ev);
    expect(await prisma.productReview.count({ where: { authorPersonId: people[0]! } })).toBe(0);
    expect(await prisma.productReview.count({ where: { listingId: l2 } })).toBe(0);
    const kept = await prisma.productReview.findUniqueOrThrow({ where: { id: approved.id } });
    expect(kept.authorPersonId.startsWith(TOMBSTONE_PERSON_ID.slice(0, 24))).toBe(true);
    expect(kept.status).toBe("approved");
    expect((await prisma.productComment.findUniqueOrThrow({ where: { id: c.id } })).authorPersonId).toBe(TOMBSTONE_PERSON_ID);
    expect((await listApprovedReviews(l1)).items[0]!.authorName).toBe("Former user");
  });
});
