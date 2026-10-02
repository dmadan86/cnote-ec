import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Security audit M2: a refunded lead must stop backing the "verified enquiry" badge on reviews the buyer already left.
const state = vi.hoisted(() => ({ accepted: new Set<string>(), buyerOf: new Map<string, string>() }));
vi.mock("@cnote/ai", async (orig) => ({ ...(await orig<typeof import("@cnote/ai")>()) }));
vi.mock("@cnote/catalogue", () => ({ getListing: async () => null, listSellerListings: async () => [] }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => new Map() }));
vi.mock("@cnote/enquiry", () => ({
  hasAcceptedMatch: async (buyer: string, seller: string) => state.accepted.has(`${buyer}:${seller}`),
  getEnquirySummary: async (id: string) => (state.buyerOf.has(id) ? { id, title: "t", buyerBusinessId: state.buyerOf.get(id)!, buyerPersonId: randomUUID(), intentScore: 1, status: "matched" } : null),
}));

import { worker } from "../src";

const seller = randomUUID();
const buyer = randomUUID();
const otherBuyer = randomUUID();
const listing = randomUUID();
const person = (): string => randomUUID();
const reviewIds: string[] = [];
const mk = async (authorBusinessId: string, verified: boolean) => {
  const r = await prisma.productReview.create({
    data: { listingId: listing, sellerBusinessId: seller, authorPersonId: person(), authorBusinessId, rating: 5, body: "Good supplier, on time delivery.", verifiedEnquiry: verified, status: "approved" },
  });
  reviewIds.push(r.id);
  return r.id;
};
const refunded = (enquiryId: string) =>
  ({ id: 1, type: "LeadRefunded", version: 1, aggregateType: "enquiry", aggregateId: enquiryId, payload: { enquiryId, matchId: randomUUID(), sellerBusinessId: seller, reason: "buyer_fake" }, occurredAt: "" }) as never;

afterAll(async () => {
  await prisma.productReview.deleteMany({ where: { id: { in: reviewIds } } });
});

describe("LeadRefunded -> verified-enquiry badge", () => {
  it("drops the badge when the refunded lead was the buyer's only accepted lead with that seller; keeps it when another remains", async () => {
    const enq = randomUUID();
    state.buyerOf.set(enq, buyer);
    const mine = await mk(buyer, true);
    const other = await mk(otherBuyer, true); // a different buyer is untouched
    state.accepted.add(`${buyer}:${seller}`); // buyer still has another accepted lead: badge stays
    await worker.handlers!.LeadRefunded!(refunded(enq));
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: mine } })).verifiedEnquiry).toBe(true);
    state.accepted.clear(); // no accepted lead left: badge goes
    await worker.handlers!.LeadRefunded!(refunded(enq));
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: mine } })).verifiedEnquiry).toBe(false);
    expect((await prisma.productReview.findUniqueOrThrow({ where: { id: other } })).verifiedEnquiry).toBe(true);
  });
  it("is a no-op for an unknown enquiry", async () => {
    await expect(worker.handlers!.LeadRefunded!(refunded(randomUUID()))).resolves.toBeUndefined();
  });
});
