import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.fn(async (_t?: string[]) => {});
const soft = vi.fn(async (_t?: string[]) => {});
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<any>()), invalidateTags: (t: string[]) => invalidate(t), softInvalidateTags: (t: string[]) => soft(t) }));

const { cacheHandlers: typedHandlers, cacheWorker } = await import("../src/cache-worker");
const cacheHandlers = typedHandlers as Record<string, (e: any) => Promise<unknown>>;
const { cacheTags } = await import("@cnote/core");

const ev = (payload: object) => ({ id: 1, type: "x", version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: "" }) as any;
const fetchMock = vi.fn();
const webTags = () => (JSON.parse(fetchMock.mock.calls[0]![1].body).tags as { tag: string; hard?: boolean }[]);

beforeEach(() => {
  invalidate.mockClear(); soft.mockClear(); fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  process.env.REVALIDATE_SECRET = "sekret";
  delete process.env.WEB_REVALIDATE_URL;
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.REVALIDATE_SECRET; });

describe("cache worker", () => {
  it("is a module worker named cache", () => expect(cacheWorker.name).toBe("cache"));

  it.each(["ListingUnpublished", "ListingModerated", "ListingArchived", "ListingImageModerated"])("%s hard-purges redis + web (withdrawals never stale)", async (name) => {
    await cacheHandlers[name]!(ev({ listingId: "L", sellerBusinessId: "S" }));
    expect(invalidate).toHaveBeenCalledWith([cacheTags.listing("L"), cacheTags.sellerListings("S"), cacheTags.sitemap]);
    expect(soft).toHaveBeenCalledWith([cacheTags.featured, cacheTags.search]);
    const t = webTags();
    for (const tag of [cacheTags.listing("L"), cacheTags.featured, cacheTags.search]) expect(t.find((x) => x.tag === tag)?.hard).toBe(true);
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer sekret");
  });

  it.each(["ListingPublished", "ListingVersionPublished"])("%s only soft-invalidates", async (name) => {
    await cacheHandlers[name]!(ev({ listingId: "L", sellerBusinessId: "S" }));
    expect(invalidate).not.toHaveBeenCalled();
    expect(soft).toHaveBeenCalled();
    expect(webTags().every((x) => !x.hard)).toBe(true);
  });

  it.each(["ReviewModerated", "CommentModerated"])("%s purges review + rating tags hard", async (name) => {
    await cacheHandlers[name]!(ev({ listingId: "L" }));
    expect(invalidate).toHaveBeenCalledWith([cacheTags.rating("L"), cacheTags.reviews("L")]);
    expect(webTags().every((x) => x.hard)).toBe(true);
  });

  it.each(["TrustScoreChanged", "BusinessVerified"])("%s purges seller tags", async (name) => {
    await cacheHandlers[name]!(ev({ businessId: "B" }));
    expect(invalidate).toHaveBeenCalledWith([cacheTags.seller("B"), cacheTags.sellers, cacheTags.sitemap]);
  });

  it("BusinessCreated only for sellers", async () => {
    await cacheHandlers.BusinessCreated!(ev({ businessId: "B", isSeller: false }));
    expect(invalidate).not.toHaveBeenCalled();
    await cacheHandlers.BusinessCreated!(ev({ businessId: "B", isSeller: true }));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("DataErasureRequested purges all reviews", async () => {
    await cacheHandlers.DataErasureRequested!(ev({}));
    expect(invalidate).toHaveBeenCalledWith([cacheTags.reviewsAll]);
  });

  it("skips the web tier without a secret, uses WEB_REVALIDATE_URL when set", async () => {
    delete process.env.REVALIDATE_SECRET;
    await cacheHandlers.ListingArchived!(ev({ listingId: "L", sellerBusinessId: "S" }));
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.REVALIDATE_SECRET = "s";
    process.env.WEB_REVALIDATE_URL = "https://web.test/rv";
    await cacheHandlers.ListingArchived!(ev({ listingId: "L", sellerBusinessId: "S" }));
    expect(fetchMock.mock.calls[0]![0]).toBe("https://web.test/rv");
  });

  it("web failures (non-2xx or network) never throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(cacheHandlers.ListingArchived!(ev({ listingId: "L", sellerBusinessId: "S" }))).resolves.not.toThrow();
    fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(cacheHandlers.ListingArchived!(ev({ listingId: "L", sellerBusinessId: "S" }))).resolves.not.toThrow();
    fetchMock.mockRejectedValueOnce("str");
    await cacheHandlers.ListingArchived!(ev({ listingId: "L", sellerBusinessId: "S" }));
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });
});
