import { beforeEach, describe, expect, it, vi } from "vitest";

// SEO policy: an active custom domain is canonical; otherwise the marketplace /store/<slug> path. Never both.
const custom = vi.hoisted(() => new Map<string, string>());
vi.mock("@cnote/domains", () => ({ customDomainOrigin: vi.fn(async (slug: string) => custom.get(slug) ?? null) }));
vi.mock("@cnote/storefront", () => ({ getStorefrontCanonical: async (slug: string, page = "") => `https://market.test/store/${slug}${page && page !== "home" ? `/${page}` : ""}` }));
vi.mock("@cnote/storefront/render", () => ({ findPage: () => ({}) }));

const { canonicalFor, platformCanonicalStorefronts } = await import("../src/features/storefront/seo");

beforeEach(() => custom.clear());

describe("storefront canonical URLs", () => {
  it("uses the marketplace path when the seller has no active custom domain", async () => {
    expect(await canonicalFor("acme", "home")).toBe("https://market.test/store/acme");
    expect(await canonicalFor("acme", "about")).toBe("https://market.test/store/acme/about");
  });

  it("uses the active custom domain (root for home, /<page> otherwise)", async () => {
    custom.set("acme", "https://www.acme.com");
    expect(await canonicalFor("acme", "home")).toBe("https://www.acme.com/");
    expect(await canonicalFor("acme", "/about")).toBe("https://www.acme.com/about");
  });

  it("falls back to the marketplace path if the domain lookup fails", async () => {
    const { customDomainOrigin } = await import("@cnote/domains");
    vi.mocked(customDomainOrigin).mockRejectedValueOnce(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementationOnce(() => undefined);
    expect(await canonicalFor("acme", "home")).toBe("https://market.test/store/acme");
  });

  it("lists only platform-canonical storefronts in the marketplace sitemap", async () => {
    custom.set("b", "https://b.example");
    expect(await platformCanonicalStorefronts(["a", "b", "c"])).toEqual(["a", "c"]);
  });
});
