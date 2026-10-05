import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  hard: [] as string[][],
  soft: [] as string[][],
  slugByBiz: new Map<string, string>(),
  slugById: new Map<string, string>(),
}));
vi.mock("@cnote/core", async (orig) => ({
  ...(await orig<typeof import("@cnote/core")>()),
  invalidateTags: async (t: string[]) => void h.hard.push(t),
  softInvalidateTags: async (t: string[]) => void h.soft.push(t),
}));
vi.mock("../src/service", () => ({
  storefrontSlugForBusiness: async (id: string) => h.slugByBiz.get(id) ?? null,
  storefrontSlugById: async (id: string) => h.slugById.get(id) ?? null,
}));

import { getStorefrontCanonical, purgeStorefront, purgeWeb, siteOrigin, storefrontTag } from "../src/cache";
import { storefrontHandlers, worker } from "../src/worker";

const ev = (payload: Record<string, unknown>) => ({ payload }) as never;
const env = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.hard.length = 0;
  h.soft.length = 0;
  h.slugByBiz.set("biz1", "acme");
  h.slugById.set("sf1", "acme");
  process.env.REVALIDATE_SECRET = "s3cret";
  process.env.APP_URL = "https://cnote.test/";
  delete process.env.WEB_REVALIDATE_URL;
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
});

describe("cache helpers", () => {
  it("builds tags and canonical urls (no trailing slashes, home collapses)", async () => {
    expect(storefrontTag("acme")).toBe("storefront:acme");
    expect(siteOrigin()).toBe("https://cnote.test");
    expect(await getStorefrontCanonical("acme")).toBe("https://cnote.test/store/acme");
    expect(await getStorefrontCanonical("acme", "home")).toBe("https://cnote.test/store/acme");
    expect(await getStorefrontCanonical("acme", "/about")).toBe("https://cnote.test/store/acme/about");
    delete process.env.APP_URL;
    expect(siteOrigin()).toBe("http://localhost:3000");
  });
  it("purgeStorefront de-dupes, drops empties, hard vs soft, and posts to the web tier with auth", async () => {
    await purgeStorefront(["a", "a", "", "b"], true);
    expect(h.hard).toEqual([["storefront:a", "storefront:b"]]);
    expect(h.soft).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cnote.test/api/revalidate");
    expect(init.headers.authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init.body)).toEqual({ tags: [{ tag: "storefront:a", hard: true }, { tag: "storefront:b", hard: true }] });
    await purgeStorefront(["c"], false);
    expect(h.soft).toEqual([["storefront:c"]]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).tags[0].hard).toBe(false);
  });
  it("no-ops for an empty list; skips web tier without a secret; honours WEB_REVALIDATE_URL", async () => {
    await purgeStorefront([]);
    await purgeStorefront(["", ""]);
    expect(h.hard).toEqual([]);
    delete process.env.REVALIDATE_SECRET;
    await purgeStorefront(["a"]);
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.REVALIDATE_SECRET = "x";
    process.env.WEB_REVALIDATE_URL = "https://web.internal/rv";
    await purgeWeb([{ tag: "t" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://web.internal/rv");
    await purgeWeb([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("web tier failures (non-2xx, network error) never throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(purgeStorefront(["a"])).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(purgeStorefront(["a"])).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce("weird");
    await expect(purgeWeb([{ tag: "t" }])).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });
});

describe("event handlers", () => {
  it("registers as a module worker with the embed re-check job", () => {
    expect(worker.name).toBe("storefront");
    expect(worker.jobs?.map((j) => j.name)).toEqual(["storefront.embed-recheck"]);
    expect(Object.keys(storefrontHandlers).sort()).toMatchInlineSnapshot(`
      [
        "BusinessVerified",
        "ListingArchived",
        "ListingImageModerated",
        "ListingModerated",
        "ListingPublished",
        "ListingUnpublished",
        "ListingVersionPublished",
        "ReviewModerated",
        "StorefrontDomainStatusChanged",
        "StorefrontEmbedDecided",
        "StorefrontPublished",
        "StorefrontSuspended",
        "StorefrontVersionReviewed",
        "TrustScoreChanged",
      ]
    `);
  });
  const call = (name: string, payload: Record<string, unknown>) => (storefrontHandlers as Record<string, (e: never) => Promise<void>>)[name]!(ev(payload));

  it("moderation-class events purge HARD (never serve stale)", async () => {
    await call("StorefrontPublished", { slug: "acme" });
    await call("StorefrontVersionReviewed", { storefrontId: "sf1" });
    await call("StorefrontSuspended", { storefrontId: "sf1" });
    await call("StorefrontDomainStatusChanged", { storefrontId: "sf1" });
    for (const n of ["ListingModerated", "ListingArchived", "ListingImageModerated", "ReviewModerated", "ListingUnpublished"]) await call(n, { sellerBusinessId: "biz1" });
    expect(h.hard).toHaveLength(9);
    expect(h.hard.every((t) => t.length === 1 && t[0] === "storefront:acme")).toBe(true);
    expect(h.soft).toEqual([]);
  });
  it("ranking/trust-class events purge SOFT", async () => {
    await call("TrustScoreChanged", { businessId: "biz1" });
    await call("BusinessVerified", { businessId: "biz1" });
    await call("ListingPublished", { sellerBusinessId: "biz1" });
    await call("ListingVersionPublished", { sellerBusinessId: "biz1" });
    expect(h.soft).toHaveLength(4);
    expect(h.hard).toEqual([]);
  });
  it("unknown sellers/storefronts are ignored (idempotent, no throw)", async () => {
    await call("TrustScoreChanged", { businessId: "nobody" });
    await call("StorefrontSuspended", { storefrontId: "nobody" });
    await call("ReviewModerated", { sellerBusinessId: "nobody" });
    expect(h.hard).toEqual([]);
    expect(h.soft).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("replaying an event yields the same purge", async () => {
    await call("ListingArchived", { sellerBusinessId: "biz1" });
    await call("ListingArchived", { sellerBusinessId: "biz1" });
    expect(h.hard[0]).toEqual(h.hard[1]);
  });
});
