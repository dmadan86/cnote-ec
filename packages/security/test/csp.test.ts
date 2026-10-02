import { describe, expect, it } from "vitest";
import { buildCsp, EMBED_FRAME_ORIGINS, securityHeaders, staticHeaderList } from "../src";

const prod = { NODE_ENV: "production" } as const;
const dir = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);

describe("buildCsp", () => {
  it("nonce mode: strict-dynamic, no unsafe-inline scripts, locked down basics", () => {
    const csp = buildCsp({ app: "admin", nonce: "abc123==", env: prod });
    expect(dir(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(dir(csp, "default-src")).toBe("default-src 'self'");
    expect(dir(csp, "object-src")).toBe("object-src 'none'");
    expect(dir(csp, "base-uri")).toBe("base-uri 'self'");
    expect(dir(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).not.toContain("clarity");
  });

  it("static mode swaps the nonce for unsafe-inline scripts", () => {
    const csp = buildCsp({ app: "web", env: prod });
    expect(dir(csp, "script-src")).toBe("script-src 'self' 'unsafe-inline'");
    expect(dir(csp, "frame-ancestors")).toBe("frame-ancestors 'self'");
  });

  it("web + analytics + turnstile + media + sentry", () => {
    const csp = buildCsp({
      app: "web",
      nonce: "n",
      env: {
        ...prod,
        NEXT_PUBLIC_CLARITY_PROJECT_ID: "x",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k",
        MEDIA_PUBLIC_BASE_URL: "https://media.example.in/public/",
        NEXT_PUBLIC_SENTRY_DSN: "https://pub@o1.ingest.sentry.io/2",
      },
    });
    expect(dir(csp, "script-src")).toContain("https://www.clarity.ms");
    expect(dir(csp, "script-src")).toContain("https://challenges.cloudflare.com");
    expect(dir(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com https://www.openstreetmap.org");
    expect(dir(buildCsp({ app: "admin", nonce: "n", env: prod }), "frame-src")).toBe("frame-src 'none'");
    expect(dir(csp, "img-src")).toContain("https://media.example.in");
    expect(dir(csp, "connect-src")).toContain("https://o1.ingest.sentry.io");
    expect(dir(csp, "connect-src")).toContain("https://*.clarity.ms");
  });

  it("frame-src allows ONLY the privacy-enhanced storefront embed hosts on the web, and nothing on the other apps", () => {
    expect(dir(buildCsp({ app: "web", nonce: "n", env: prod }), "frame-src")).toBe("frame-src https://www.youtube-nocookie.com https://www.openstreetmap.org");
    expect([...EMBED_FRAME_ORIGINS]).toEqual(["https://www.youtube-nocookie.com", "https://www.openstreetmap.org"]);
    // static (ISR) mode carries the same directive
    expect(dir(buildCsp({ app: "web", env: prod }), "frame-src")).toBe("frame-src https://www.youtube-nocookie.com https://www.openstreetmap.org");
    // the regular YouTube host (cookies, tracking) is never framed
    expect(buildCsp({ app: "web", nonce: "n", env: prod })).not.toMatch(/https:\/\/www\.youtube\.com|https:\/\/youtube\.com/);
    expect(dir(buildCsp({ app: "web", nonce: "n", embeds: false, env: prod }), "frame-src")).toBe("frame-src 'none'");
    for (const app of ["seller", "admin", "studio", "api"] as const) expect(dir(buildCsp({ app, nonce: "n", env: prod }), "frame-src"), app).toBe("frame-src 'none'");
    // an app that is not the web cannot opt in
    expect(dir(buildCsp({ app: "seller", nonce: "n", embeds: true, env: prod }), "frame-src")).toBe("frame-src 'none'");
  });

  it("clarity is web-only", () => {
    expect(buildCsp({ app: "admin", analytics: true, env: prod })).not.toContain("clarity");
  });

  it("dev allows eval + websockets and skips HTTPS upgrade", () => {
    const csp = buildCsp({ app: "web", nonce: "n", env: { NODE_ENV: "development" } });
    expect(csp).toContain("'unsafe-eval'");
    expect(dir(csp, "connect-src")).toContain("ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("strictStyles nonces style elements", () => {
    const csp = buildCsp({ app: "seller", nonce: "n", strictStyles: true, env: prod });
    expect(dir(csp, "style-src-elem")).toContain("'nonce-n'");
    expect(dir(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    expect(dir(csp, "style-src")).toBe("style-src 'self'");
  });

  it("rejects injected sources and bad nonces", () => {
    expect(() => buildCsp({ app: "web", allow: { scripts: ["https://a.com; script-src *"] } })).toThrow();
    expect(() => buildCsp({ app: "web", nonce: "a'; b" })).toThrow();
  });
});

describe("securityHeaders", () => {
  it("emits the full header set in production", () => {
    const h = securityHeaders({ app: "admin", nonce: "n", env: prod });
    expect(h["Content-Security-Policy"]).toBeTruthy();
    expect(h["Strict-Transport-Security"]).toContain("max-age=");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Robots-Tag"]).toContain("noindex");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Cross-Origin-Resource-Policy"]).toBe("same-site");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });

  it("web is indexable, frameable by itself, and can opt into the microphone", () => {
    const h = securityHeaders({ app: "web", microphone: true, env: prod });
    expect(h["X-Robots-Tag"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(h["Permissions-Policy"]).toContain("microphone=(self)");
  });

  it("no HSTS outside production; CSP_REPORT_ONLY switches the header name", () => {
    const h = securityHeaders({ app: "web", env: { NODE_ENV: "development", CSP_REPORT_ONLY: "1" } });
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["Content-Security-Policy-Report-Only"]).toBeTruthy();
  });

  it("staticHeaderList is next.config shaped", () => {
    const list = staticHeaderList({ app: "web", env: prod });
    expect(list.find((x) => x.key === "Content-Security-Policy")?.value).toContain("'unsafe-inline'");
  });
});
