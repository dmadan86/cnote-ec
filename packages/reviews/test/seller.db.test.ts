import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/catalogue", () => ({ getListing: async () => null, listSellerListings: async () => [] }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => new Map(), getPersonVerification: async () => ({ phone: null, phoneVerified: false, emailVerified: true, erased: false, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }) }));
vi.mock("@cnote/enquiry", () => ({}));

import { bustAllReviewCaches, bustReviewCaches } from "../src/cache";
import { getSellerRatingSummaries, listApprovedSellerReviews } from "../src";

const seller = randomUUID();
const quiet = randomUUID();
const ids: string[] = [];

async function review(sellerBusinessId: string, rating: number, status: "approved" | "pending" | "rejected", extra: { reply?: boolean } = {}) {
  const r = await prisma.productReview.create({
    data: {
      listingId: randomUUID(), sellerBusinessId, authorPersonId: randomUUID(), rating, body: `body ${rating} ${status}`, status,
      ...(extra.reply ? { sellerReply: "Thank you", sellerReplyStatus: "approved" as const, sellerRepliedAt: new Date() } : {}),
    },
  });
  ids.push(r.id);
  return r;
}

afterAll(async () => {
  await prisma.productReview.deleteMany({ where: { id: { in: ids } } });
});

describe("seller-level reviews", () => {
  it("aggregates approved ratings only and reports zero for an unrated seller", async () => {
    await review(seller, 5, "approved");
    await review(seller, 4, "approved", { reply: true });
    await review(seller, 1, "pending");
    await review(seller, 1, "rejected");
    await bustReviewCaches(randomUUID());
    const m = await getSellerRatingSummaries([seller, quiet]);
    expect(m.get(seller)).toMatchObject({ count: 2, average: 4.5, histogram: [0, 0, 0, 1, 1] });
    expect(m.get(quiet)).toMatchObject({ count: 0, average: 0 });
    expect((await getSellerRatingSummaries([])).size).toBe(0);
  });

  it("lists approved reviews newest first with approved seller replies, paginated by cursor", async () => {
    await bustAllReviewCaches();
    const first = await listApprovedSellerReviews(seller, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("1");
    const second = await listApprovedSellerReviews(seller, { limit: 1, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(all.map((r) => r.rating).sort()).toEqual([4, 5]);
    expect(all.every((r) => r.body.endsWith("approved"))).toBe(true);
    expect(all.find((r) => r.rating === 4)!.sellerReply?.body).toBe("Thank you");
    expect(all[0]!.authorName).toBe("Buyer");
    expect(first.items[0]!.listingId).toBeTruthy();
  });
});
