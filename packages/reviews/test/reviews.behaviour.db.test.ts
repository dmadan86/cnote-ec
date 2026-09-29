import { prisma } from "@cnote/db";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listings: new Map<string, { id: string; sellerBusinessId: string; status: string }>(),
  verdict: "allow" as "allow" | "review" | "block" | "throw",
  allowRate: true,
  accepted: "yes" as "yes" | "no" | "throw",
  names: new Map<string, { name: string }>(),
  identityThrows: false,
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async () => {
    if (state.verdict === "throw") throw new Error("model down");
    return { verdict: state.verdict, flags: [], reason: null, decisionId: randomUUID(), confidence: 1, needsReview: false };
  },
}));
vi.mock("@cnote/catalogue", () => ({
  getListing: async (id: string) => state.listings.get(id) ?? null,
  listSellerListings: async (biz: string) => [...state.listings.values()].filter((l) => l.sellerBusinessId === biz),
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async () => {
    if (state.identityThrows) throw new Error("identity down");
    return state.names;
  },
}));
vi.mock("@cnote/enquiry", () => ({
  hasAcceptedMatch: async () => {
    if (state.accepted === "throw") throw new Error("boom");
    return state.accepted === "yes";
  },
}));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => state.allowRate }));

import {
  getCommentAuthor, getModerationItem, getRatingSummaries, getRatingSummary, getReviewAuthor, isTombstone, listApprovedComments, listApprovedReviews,
  listModerationQueue, listMyPendingComments, listSellerUgc, moderate, react, replyToComment, replyToReview, submitComment, submitReview, TOMBSTONE_PERSON_ID, worker,
} from "../src";
import { anonymisePerson } from "../src/worker";

const sellerBiz = randomUUID();
const seller = { personId: randomUUID(), businessId: sellerBiz };
const staff = randomUUID();
const people = Array.from({ length: 8 }, () => randomUUID());
const as = (i: number, businessId: string | null = null) => ({ personId: people[i]!, businessId });
const listingIds: string[] = [];
const newListing = (status = "published") => {
  const id = randomUUID();
  state.listings.set(id, { id, sellerBusinessId: sellerBiz, status });
  listingIds.push(id);
  return id;
};
const body = "This is a perfectly reasonable review body text.";
const good = (rating = 4) => ({ rating, title: "ok", body });

beforeEach(() => {
  state.verdict = "allow"; state.allowRate = true; state.accepted = "yes"; state.names = new Map(); state.identityThrows = false;
});
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

async function expectedAggregate(listingId: string) {
  const rows = await prisma.productReview.findMany({ where: { listingId, status: "approved" } });
  const hist = [0, 0, 0, 0, 0];
  for (const r of rows) hist[r.rating - 1]!++;
  return { count: rows.length, sum: rows.reduce((s, r) => s + r.rating, 0), hist };
}
async function storedAggregate(listingId: string) {
  const s = await prisma.listingRatingSummary.findUnique({ where: { listingId } });
  return s ? { count: s.ratingCount, sum: s.ratingSum, hist: s.histogram } : { count: 0, sum: 0, hist: [0, 0, 0, 0, 0] };
}

describe("aggregate property", () => {
  type Op = { k: "submit"; p: number; rating: number } | { k: "approve" | "reject" | "report"; p: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ k: fc.constant("submit" as const), p: fc.nat(3), rating: fc.integer({ min: 1, max: 5 }) }),
    fc.record({ k: fc.constantFrom("approve" as const, "reject" as const, "report" as const), p: fc.nat(3) }),
  );

  it("stored aggregate always equals recompute from approved rows after any sequence of submit/edit/approve/reject/report", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
        const l = newListing();
        for (const op of ops) {
          const existing = await prisma.productReview.findFirst({ where: { listingId: l, authorPersonId: people[op.p]! } });
          if (op.k === "submit") await submitReview(as(op.p), l, good(op.rating));
          else if (!existing) continue;
          else if (op.k === "approve") await moderate("review", existing.id, "approved", null, staff);
          else if (op.k === "reject") await moderate("review", existing.id, "rejected", "nope", staff);
          else {
            for (const r of [4, 5, 6, 7]) await react(as(r), { subjectType: "review", subjectId: existing.id, kind: "report", reason: "spam" }).catch(() => undefined);
          }
          expect(await storedAggregate(l)).toEqual(await expectedAggregate(l));
          const view = await getRatingSummary(l);
          const exp = await expectedAggregate(l);
          expect(view.count).toBe(exp.count);
          expect(view.average).toBe(exp.count ? Math.round((exp.sum / exp.count) * 10) / 10 : 0);
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe("verified enquiry + screening fallback", () => {
  it("sets verifiedEnquiry from hasAcceptedMatch; fails closed on error or no business", async () => {
    const l = newListing();
    const r = await submitReview(as(0, randomUUID()), l, good());
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } })).verifiedEnquiry).toBe(true);
    state.accepted = "no";
    const r2 = await submitReview(as(1, randomUUID()), l, good());
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r2.id } })).verifiedEnquiry).toBe(false);
    state.accepted = "throw";
    const r3 = await submitReview(as(2, randomUUID()), l, good());
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r3.id } })).verifiedEnquiry).toBe(false);
    state.accepted = "yes";
    const r4 = await submitReview(as(3, null), l, good());
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r4.id } })).verifiedEnquiry).toBe(false);
  });

  it("AI outage falls back to pending with no verdict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.verdict = "throw";
    const l = newListing();
    const r = await submitReview(as(0), l, good());
    const row = await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: "pending", aiVerdict: null });
  });

  it("unpublished listing is not reviewable/commentable; rate limits raise rate_limited", async () => {
    const draft = newListing("draft");
    await expect(submitReview(as(0), draft, good())).rejects.toMatchObject({ code: "not_found" });
    await expect(submitComment(as(0), draft, { body: "hello there" })).rejects.toMatchObject({ code: "not_found" });
    const l = newListing();
    state.allowRate = false;
    await expect(submitReview(as(0), l, good())).rejects.toMatchObject({ code: "rate_limited" });
    await expect(submitComment(as(0), l, { body: "hello there" })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(react(as(0), { subjectType: "review", subjectId: randomUUID(), kind: "helpful" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(await prisma.productReview.count({ where: { listingId: l } })).toBe(0);
  });

  it("concurrent double-submit by one person leaves exactly one review", async () => {
    const l = newListing();
    const res = await Promise.allSettled([submitReview(as(0), l, good(3)), submitReview(as(0), l, good(4)), submitReview(as(0), l, good(5))]);
    expect(res.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of res) if (r.status === "rejected") expect(r.reason.code).toBe("conflict");
    expect(await prisma.productReview.count({ where: { listingId: l } })).toBe(1);
  });
});

describe("reactions on comments + report threshold", () => {
  it("helpful is review-only; comment reports re-flag at threshold; own posts protected", async () => {
    const l = newListing();
    const c = await submitComment(as(0), l, { body: "Is this available in blue?" });
    await moderate("comment", c.id, "approved", null, staff);
    await expect(react(as(1), { subjectType: "comment", subjectId: c.id, kind: "helpful" })).rejects.toMatchObject({ code: "validation" });
    await expect(react(as(0), { subjectType: "comment", subjectId: c.id, kind: "report", reason: "spam" })).rejects.toMatchObject({ code: "forbidden" });
    for (const p of [1, 2]) await react(as(p), { subjectType: "comment", subjectId: c.id, kind: "report", reason: "spam" });
    expect((await prisma.productComment.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("approved");
    await react(as(3), { subjectType: "comment", subjectId: c.id, kind: "report", reason: "spam" });
    expect((await prisma.productComment.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("flagged");
    expect(await listApprovedComments(l)).toHaveLength(0);
    await expect(react(as(4), { subjectType: "comment", subjectId: randomUUID(), kind: "report", reason: "spam" })).rejects.toMatchObject({ code: "not_found" });
    await expect(react(as(4), { subjectType: "comment", subjectId: c.id, kind: "report", reason: "x" })).rejects.toThrow();
  });

  it("concurrent duplicate helpful votes count once", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good());
    await moderate("review", r.id, "approved", null, staff);
    const res = await Promise.all(Array.from({ length: 5 }, () => react(as(1), { subjectType: "review", subjectId: r.id, kind: "helpful" }).catch(() => ({ changed: false }))));
    expect(res.filter((x) => x.changed)).toHaveLength(1);
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: r.id } })).helpfulCount).toBe(1);
  });
});

describe("read paths", () => {
  it("sorts, paginates with cursors, names authors, hides unapproved seller replies", async () => {
    const l = newListing();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await submitReview(as(i), l, good(i + 1));
      await moderate("review", r.id, "approved", null, staff);
      ids.push(r.id);
    }
    await react(as(7), { subjectType: "review", subjectId: ids[1]!, kind: "helpful" });
    expect((await listApprovedReviews(l, { sort: "rating_high" })).items.map((r) => r.rating)).toEqual([5, 4, 3, 2, 1]);
    expect((await listApprovedReviews(l, { sort: "rating_low" })).items.map((r) => r.rating)).toEqual([1, 2, 3, 4, 5]);
    expect((await listApprovedReviews(l, { sort: "helpful" })).items[0]!.id).toBe(ids[1]);
    const p1 = await listApprovedReviews(l, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe("2");
    const p2 = await listApprovedReviews(l, { limit: 2, cursor: p1.nextCursor });
    const p3 = await listApprovedReviews(l, { limit: 2, cursor: p2.nextCursor });
    expect(p3.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items, ...p3.items].map((r) => r.id);
    expect(new Set(all).size).toBe(5);
    expect((await listApprovedReviews(l, { limit: 2, cursor: "garbage" })).items).toHaveLength(2); // invalid cursor -> offset 0
    expect(p1.items[0]!.authorName).toBe("Buyer");
  });

  it("author display names come from identity, degrade gracefully, and tombstones are 'Former user'", async () => {
    const l = newListing();
    const biz = randomUUID();
    state.names = new Map([[biz, { name: "Acme Traders" }]]);
    const r = await submitReview(as(0, biz), l, good());
    await moderate("review", r.id, "approved", null, staff);
    expect((await listApprovedReviews(l)).items[0]!.authorName).toBe("Acme Traders");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.identityThrows = true;
    await prisma.$executeRaw`SELECT 1`;
    const l2 = newListing();
    const r2 = await submitReview(as(1, biz), l2, good());
    await moderate("review", r2.id, "approved", null, staff);
    expect((await listApprovedReviews(l2)).items[0]!.authorName).toBe("Buyer");
    expect(isTombstone(TOMBSTONE_PERSON_ID)).toBe(true);
    expect(isTombstone(people[0]!)).toBe(false);
  });

  it("getRatingSummaries returns one entry per id incl. unrated, dedupes; empty input", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good(5));
    await moderate("review", r.id, "approved", null, staff);
    const other = randomUUID();
    const m = await getRatingSummaries([l, other, l]);
    expect([...m.keys()].sort()).toEqual([l, other].sort());
    expect(m.get(l)).toMatchObject({ count: 1, average: 5, histogram: [0, 0, 0, 0, 1] });
    expect(m.get(other)).toMatchObject({ count: 0, average: 0, histogram: [0, 0, 0, 0, 0] });
    expect((await getRatingSummaries([])).size).toBe(0);
  });

  it("listSellerUgc: needsReply filter, listing scope, pagination for reviews and comments", async () => {
    const l = newListing();
    const rs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await submitReview(as(i), l, good());
      await moderate("review", r.id, "approved", null, staff);
      rs.push(r.id);
    }
    await replyToReview(seller, rs[0]!, "Thanks a lot!");
    await moderate("reply", rs[0]!, "rejected", "Be polite", staff);
    await replyToReview(seller, rs[1]!, "Appreciate it!");
    await moderate("reply", rs[1]!, "approved", null, staff);
    const need = await listSellerUgc(sellerBiz, { kind: "review", listingId: l, needsReply: true });
    expect(new Set(need.items.map((i) => i.id))).toEqual(new Set([rs[0]!, rs[2]!]));
    expect(need.items.find((i) => i.id === rs[0])!.reply).toMatchObject({ status: "rejected", moderationNote: "Be polite" });
    const pg = await listSellerUgc(sellerBiz, { kind: "review", listingId: l, limit: 2 });
    expect(pg.items).toHaveLength(2);
    expect(pg.nextCursor).toBe("2");
    expect((await listSellerUgc(sellerBiz, { listingId: l, limit: 2, cursor: "2" })).items).toHaveLength(1);

    const cs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await submitComment(as(i), l, { body: `Question number ${i} here?` });
      await moderate("comment", c.id, "approved", null, staff);
      cs.push(c.id);
    }
    const a = await replyToComment(seller, cs[0]!, "Yes indeed.");
    await moderate("comment", a.id, "approved", null, staff);
    const b = await replyToComment(seller, cs[1]!, "Nope, sorry.");
    await moderate("comment", b.id, "rejected", "rude", staff);
    const cn = await listSellerUgc(sellerBiz, { kind: "comment", listingId: l, needsReply: true });
    expect(new Set(cn.items.map((i) => i.id))).toEqual(new Set([cs[1]!, cs[2]!]));
    expect(cn.items.find((i) => i.id === cs[1])!.reply).toMatchObject({ status: "rejected", moderationNote: "rude" });
    const cp = await listSellerUgc(sellerBiz, { kind: "comment", listingId: l, limit: 2 });
    expect(cp.nextCursor).toBe("2");
    expect((await listSellerUgc(sellerBiz, { kind: "comment", listingId: randomUUID() })).items).toHaveLength(0);
    expect((await listSellerUgc(randomUUID(), { kind: "comment" })).items).toHaveLength(0);
    await expect(replyToComment(seller, randomUUID(), "hello")).rejects.toMatchObject({ code: "not_found" });
    await expect(replyToReview(seller, randomUUID(), "hello")).rejects.toMatchObject({ code: "not_found" });
  });

  it("listMyPendingComments hides approved and shows rejection note; comment on another listing's parent is rejected", async () => {
    const l = newListing();
    const l2 = newListing();
    const c1 = await submitComment(as(0), l, { body: "Pending question here" });
    const c2 = await submitComment(as(0), l, { body: "Rejected question here" });
    const c3 = await submitComment(as(0), l, { body: "Approved question here" });
    await moderate("comment", c2.id, "rejected", "off topic", staff);
    await moderate("comment", c3.id, "approved", null, staff);
    const mine = await listMyPendingComments(l, people[0]!);
    expect(new Set(mine.map((m) => m.id))).toEqual(new Set([c1.id, c2.id]));
    expect(mine.find((m) => m.id === c2.id)).toMatchObject({ status: "rejected", moderationNote: "off topic" });
    await expect(submitComment(seller, l2, { body: "reply", parentId: c3.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(submitComment(seller, l, { body: "reply", parentId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("moderation edge cases", () => {
  it("validation, not_found, note length, getModerationItem for each kind, queue paging", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good());
    const c = await submitComment(as(1), l, { body: "A question about it?" });
    await expect(moderate("review", r.id, "rejected", "x".repeat(501), staff)).rejects.toMatchObject({ code: "validation" });
    await expect(moderate("review", randomUUID(), "approved", null, staff)).rejects.toMatchObject({ code: "not_found" });
    await expect(moderate("comment", randomUUID(), "approved", null, staff)).rejects.toMatchObject({ code: "not_found" });
    await expect(moderate("reply", r.id, "approved", null, staff)).rejects.toMatchObject({ code: "not_found" }); // no reply yet
    expect(await getModerationItem("review", "not-a-uuid")).toBeNull();
    expect(await getModerationItem("review", randomUUID())).toBeNull();
    expect(await getModerationItem("comment", randomUUID())).toBeNull();
    expect(await getModerationItem("reply", r.id)).toBeNull();
    expect(await getModerationItem("review", r.id)).toMatchObject({ kind: "review", status: "pending", rating: 4 });
    expect(await getModerationItem("comment", c.id)).toMatchObject({ kind: "comment", context: null });
    await moderate("review", r.id, "approved", null, staff);
    await replyToReview(seller, r.id, "Thank you kindly");
    expect(await getModerationItem("reply", r.id)).toMatchObject({ kind: "reply", body: "Thank you kindly", context: body, isSeller: true });
    await moderate("reply", r.id, "approved", null, staff);
    const again = await moderate("reply", r.id, "approved", null, staff);
    expect(again.before).toEqual(again.after);
    const rej = await moderate("reply", r.id, "rejected", "hmm", staff);
    expect(rej.after).toMatchObject({ status: "rejected", moderationNote: "hmm" });
    // replies to a reply thread: comment context is the parent body
    await moderate("comment", c.id, "approved", null, staff);
    const a = await replyToComment(seller, c.id, "Here is the answer.");
    expect(await getModerationItem("comment", a.id)).toMatchObject({ context: "A question about it?", parentId: c.id, isSeller: true });

    const pages: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const pg = await listModerationQueue({ kind: "comment", limit: 1, cursor });
      pages.push(...pg.items.map((x) => x.id));
      cursor = pg.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(pages).size).toBe(pages.length);
    expect((await listModerationQueue({ kind: "review", status: "flagged", limit: 100 })).items.every((i) => i.status === "flagged")).toBe(true);
  });

  it("rejected-then-approved clears the note; approve resets report count", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good());
    await moderate("review", r.id, "rejected", "  bad  ", staff);
    expect(await getModerationItem("review", r.id)).toMatchObject({ moderationNote: "bad" });
    await moderate("review", r.id, "approved", null, staff);
    expect((await getModerationItem("review", r.id))!.moderationNote).toBeNull();
  });
});

describe("getters", () => {
  it("returns authors for reviews/comments; null for malformed or unknown ids", async () => {
    const l = newListing();
    const r = await submitReview(as(0), l, good());
    const c = await submitComment(as(1), l, { body: "a question for you" });
    expect(await getReviewAuthor(r.id)).toEqual({ authorPersonId: people[0], moderationNote: null });
    expect(await getCommentAuthor(c.id)).toEqual({ authorPersonId: people[1], moderationNote: null });
    expect(await getReviewAuthor("nope")).toBeNull();
    expect(await getCommentAuthor("nope")).toBeNull();
    expect(await getReviewAuthor(randomUUID())).toBeNull();
    expect(await getCommentAuthor(randomUUID())).toBeNull();
  });
});

describe("erasure", () => {
  it("two erased people on the same listing don't collide; comments with replies survive; other people's data untouched", async () => {
    const l = newListing();
    const a = await submitReview(as(0), l, good(5));
    const b = await submitReview(as(1), l, good(2));
    const keep = await submitReview(as(2), l, good(3));
    for (const r of [a, b, keep]) await moderate("review", r.id, "approved", null, staff);
    const q = await submitComment(as(0), l, { body: "an unpublished question with reply" });
    const other = await submitComment(as(0), l, { body: "another unpublished question" });
    await moderate("comment", q.id, "approved", null, staff);
    const ans = await replyToComment(seller, q.id, "the answer text");
    await moderate("comment", ans.id, "approved", null, staff);
    await moderate("comment", q.id, "rejected", "nah", staff); // unpublished but has replies
    await anonymisePerson(people[0]!);
    await anonymisePerson(people[1]!);
    await anonymisePerson(people[1]!);
    const rows = await prisma.productReview.findMany({ where: { listingId: l } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => isTombstone(r.authorPersonId))).toHaveLength(2);
    expect(new Set(rows.map((r) => r.authorPersonId)).size).toBe(3);
    expect(rows.find((r) => r.id === keep.id)!.authorPersonId).toBe(people[2]);
    expect(await prisma.productComment.findUnique({ where: { id: other.id } })).toBeNull();
    expect((await prisma.productComment.findUniqueOrThrow({ where: { id: q.id } })).authorPersonId).toBe(TOMBSTONE_PERSON_ID);
    expect(await storedAggregate(l)).toEqual(await expectedAggregate(l)); // ratings retained
    await worker.handlers.ListingArchived!({} as never);
    expect(worker.jobs).toEqual([]);
  });
});
