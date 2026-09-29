import { beforeEach, describe, expect, it, vi } from "vitest";

// Concurrency regression: two simultaneous completeUnlock calls for the same capture must create ONE enquiry.
const state = vi.hoisted(() => ({ capture: null as Record<string, unknown> | null, enquiries: 0 }));

vi.mock("@cnote/enquiry", () => ({
  createEnquiry: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 50)); // widen the race window
    state.enquiries++;
    return { id: `00000000-0000-4000-8000-00000000000${state.enquiries}` };
  }),
}));
vi.mock("@cnote/catalogue", () => ({ getPublicListing: vi.fn(async () => ({ title: "Kraft box", category: { slug: "packaging" } })) }));
vi.mock("@cnote/identity", () => ({
  createBusiness: vi.fn(async () => ({ businessId: "b-1" })),
  getPersonBusinesses: vi.fn(async () => [{ businessId: "b-1" }]),
  getPersonVerification: vi.fn(async () => ({ phone: "+919800000000", phoneVerified: true, emailVerified: false, erased: false })),
}));
vi.mock("../src/capture", () => ({
  getCapture: vi.fn(async () => state.capture),
  markConverted: vi.fn(async (_id: string, _p: string, enquiryId: string | null) => {
    state.capture = { ...state.capture!, status: "converted", enquiryId };
  }),
}));

const { completeUnlock, UNLOCK_WAIT } = await import("../src/unlock");
const { redis } = await import("@cnote/core");

describe("completeUnlock concurrency", () => {
  beforeEach(() => {
    state.enquiries = 0;
    state.capture = { id: crypto.randomUUID(), personId: "p-1", status: "verified", unlock: "enquiry", listingId: "00000000-0000-4000-8000-0000000000aa", enquiryId: null };
  });

  it("creates exactly one enquiry for parallel submits and returns it to both callers", async () => {
    const id = state.capture!.id as string;
    const [a, b] = await Promise.all([completeUnlock("p-1", id), completeUnlock("p-1", id)]);
    expect(state.enquiries).toBe(1);
    expect(a).toMatchObject({ kind: "enquiry" });
    expect((a as { enquiryId: string }).enquiryId).toBe((b as { enquiryId: string }).enquiryId);
  });
});

describe("completeUnlock when another call holds the claim", () => {
  beforeEach(() => {
    state.enquiries = 0;
    state.capture = { id: crypto.randomUUID(), personId: "p-1", status: "verified", unlock: "enquiry", listingId: null, enquiryId: null };
  });

  it("gives up with a conflict if the other call never converts", async () => {
    const prev = { ...UNLOCK_WAIT };
    Object.assign(UNLOCK_WAIT, { intervalMs: 10, attempts: 5 });
    try {
      const id = state.capture!.id as string;
      await redis.set(`leadgen:unlock:${id}`, "someone-else", "EX", 30);
      await expect(completeUnlock("p-1", id)).rejects.toMatchObject({ code: "conflict" });
      expect(state.enquiries).toBe(0);
      await redis.del(`leadgen:unlock:${id}`);
    } finally {
      Object.assign(UNLOCK_WAIT, prev);
    }
  });

  it("reports a conflict if the claim is released without converting", async () => {
    const id = state.capture!.id as string;
    await redis.set(`leadgen:unlock:${id}`, "someone-else", "EX", 1);
    setTimeout(() => void redis.del(`leadgen:unlock:${id}`), 150);
    await expect(completeUnlock("p-1", id)).rejects.toMatchObject({ code: "conflict" });
    expect(state.enquiries).toBe(0);
  });

  it("returns the existing enquiry once the other call converts, even for a seller-contact unlock", async () => {
    state.capture = { ...state.capture!, unlock: "seller_contact" };
    const id = state.capture!.id as string;
    await redis.set(`leadgen:unlock:${id}`, "someone-else", "EX", 5);
    setTimeout(() => {
      state.capture = { ...state.capture!, status: "converted", enquiryId: "00000000-0000-4000-8000-0000000000ff" };
    }, 150);
    const res = await completeUnlock("p-1", id);
    expect(res).toMatchObject({ kind: "seller_contact", enquiryId: "00000000-0000-4000-8000-0000000000ff", contactRule: "in_app_after_match" });
    expect(state.enquiries).toBe(0);
    await redis.del(`leadgen:unlock:${id}`);
  });
});
