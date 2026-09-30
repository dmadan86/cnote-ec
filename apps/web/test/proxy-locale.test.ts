import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/domains/host-routing", () => ({ recordStorefrontHit: () => undefined, routeStorefrontHost: async () => null }));
vi.mock("@cnote/next-kit/proxy", () => ({ createAuthProxy: () => async () => new Response(null) }));

const { proxy } = await import("@/proxy");
const call = (path: string) => proxy(new NextRequest(`https://buyer.test${path}`));

// ADR-004: only en + hi are live; the other catalogues stay on disk (LOCALES in i18n/config).
describe("proxy locale routing with disabled locales", () => {
  it.each(["kn", "ta", "te", "mr", "gu", "bn"])("/%s/... redirects to the English equivalent, keeping the query", async (code) => {
    const res = await call(`/${code}/c/packaging?page=2`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://buyer.test/c/packaging?page=2");
    const root = await call(`/${code}`);
    expect(root.headers.get("location")).toBe("https://buyer.test/");
  });
  it("still serves /hi and rewrites unprefixed paths to /en", async () => {
    expect((await call("/hi/search")).headers.get("location")).toBeNull();
    expect((await call("/search")).headers.get("x-middleware-rewrite")).toContain("/en/search");
  });
});
