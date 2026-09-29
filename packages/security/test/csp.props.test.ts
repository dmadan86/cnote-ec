import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCsp, CSP_REPORT_PATH, isReportOnly, originOf, securityHeaders, sentryOrigin, staticHeaderList, type SecurityApp } from "../src";

const opts = { seed: 5, numRuns: 300 };
const apps: SecurityApp[] = ["web", "seller", "admin", "studio", "api"];
const parse = (csp: string) => new Map(csp.split("; ").map((d) => { const [name, ...v] = d.split(" "); return [name!, v] as const; }));
const b64 = fc.stringMatching(/^[A-Za-z0-9+/_=-]{1,44}$/);
const host = fc.stringMatching(/^https:\/\/[a-z0-9]{1,12}\.[a-z]{2,6}$/);
const envArb = fc.record({
  NODE_ENV: fc.constantFrom("production", "development", "test", undefined),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: fc.constantFrom("k", undefined),
  NEXT_PUBLIC_CLARITY_PROJECT_ID: fc.constantFrom("c", undefined),
  MEDIA_PUBLIC_BASE_URL: fc.constantFrom("https://media.example.in/x", "not a url", undefined),
  NEXT_PUBLIC_SENTRY_DSN: fc.constantFrom("https://k@o1.ingest.sentry.io/2", "junk", undefined),
  CSP_STRICT_STYLES: fc.constantFrom("1", "true", "0", undefined),
});

describe("buildCsp: invariants (property)", () => {
  it("nonce mode never emits unsafe script sources in production/test; unsafe-eval only in development", () => {
    fc.assert(
      fc.property(fc.constantFrom(...apps), b64, envArb, fc.boolean(), fc.boolean(), (app, nonce, env, forms, analytics) => {
        const d = parse(buildCsp({ app, nonce, env, forms, analytics }));
        const script = d.get("script-src")!;
        expect(script).not.toContain("'unsafe-inline'");
        expect(script).toContain(`'nonce-${nonce}'`);
        expect(script).toContain("'strict-dynamic'");
        expect(script).not.toContain("*");
        expect(script).not.toContain("data:");
        expect(script).not.toContain("http:");
        expect(script.includes("'unsafe-eval'")).toBe(env.NODE_ENV === "development");
      }),
      opts,
    );
  });

  it("every policy, in every mode, locks down the fixed directives", () => {
    fc.assert(
      fc.property(fc.constantFrom(...apps), fc.option(b64, { nil: undefined }), envArb, (app, nonce, env) => {
        const csp = buildCsp({ app, nonce, env });
        const d = parse(csp);
        expect(d.get("default-src")).toEqual(["'self'"]);
        expect(d.get("object-src")).toEqual(["'none'"]);
        expect(d.get("base-uri")).toEqual(["'self'"]);
        expect(d.get("worker-src")).toEqual(["'self'", "blob:"]);
        expect(d.get("frame-ancestors")).toEqual(app === "web" ? ["'self'"] : ["'none'"]);
        expect(d.get("form-action")).toEqual(app === "api" ? ["'none'"] : ["'self'", "https://accounts.google.com"]);
        expect(d.has("upgrade-insecure-requests")).toBe(env.NODE_ENV === "production");
        // directive names unique, no empty directives, no stray separators
        const names = csp.split("; ").map((x) => x.split(" ")[0]);
        expect(new Set(names).size).toBe(names.length);
        expect(csp).not.toMatch(/[\r\n,]|;;|;\s*$/);
        // connect-src never grants plain wildcards
        expect(d.get("connect-src")!.filter((s) => s === "*" || s === "http:" || s === "https:")).toEqual([]);
        expect(d.get("frame-src")!.length).toBeGreaterThan(0);
        // no host source appears twice within one directive
        for (const [, vals] of d) expect(new Set(vals).size).toBe(vals.length);
      }),
      opts,
    );
  });

  it("strict styles keep unsafe-inline out of style elements and nonce them", () => {
    fc.assert(
      fc.property(fc.constantFrom(...apps), b64, (app, nonce) => {
        const d = parse(buildCsp({ app, nonce, strictStyles: true, env: { NODE_ENV: "production" } }));
        expect(d.get("style-src-elem")).toContain(`'nonce-${nonce}'`);
        expect(d.get("style-src-elem")).not.toContain("'unsafe-inline'");
        expect(d.get("style-src")).toEqual(["'self'"]);
        expect(d.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
      }),
      opts,
    );
  });

  it("strictStyles needs a nonce: static mode ignores it and stays on unsafe-inline styles", () => {
    const d = parse(buildCsp({ app: "web", strictStyles: true, env: { NODE_ENV: "production", CSP_STRICT_STYLES: "1" } }));
    expect(d.has("style-src-elem")).toBe(false);
    expect(d.get("style-src")).toContain("'unsafe-inline'");
  });

  it("CSP_STRICT_STYLES env toggles strict styles only for 1/true", () => {
    const has = (v: string | undefined) => parse(buildCsp({ app: "web", nonce: "n", env: { CSP_STRICT_STYLES: v } })).has("style-src-elem");
    expect([has("1"), has("true"), has("0"), has("yes"), has(undefined)]).toEqual([true, true, false, false, false]);
  });

  it("allow-listed hosts are added verbatim to their directive only", () => {
    fc.assert(
      fc.property(host, host, host, host, host, host, (s, c, i, f, st, fo) => {
        const d = parse(buildCsp({ app: "admin", nonce: "n", env: { NODE_ENV: "production" }, allow: { scripts: [s], connect: [c], img: [i], frames: [f], styles: [st], fonts: [fo] } }));
        expect(d.get("script-src")).toContain(s);
        expect(d.get("connect-src")).toContain(c);
        expect(d.get("img-src")).toContain(i);
        expect(d.get("frame-src")).toContain(f);
        expect(d.get("style-src")).toContain(st);
        expect(d.get("font-src")).toContain(fo);
        expect(d.get("connect-src")).not.toContain(s);
      }),
      opts,
    );
  });

  it("any source expression containing a separator, whitespace or control char is rejected", () => {
    const bad = fc.tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.constantFrom(";", ",", " ", "\n", "\r", "\t"), fc.stringMatching(/^[a-z]{0,8}$/)).map(([a, s, b]) => `https://${a}${s}${b}`);
    fc.assert(
      fc.property(bad, fc.constantFrom("scripts", "connect", "img", "frames", "styles", "fonts"), (v, kind) => {
        expect(() => buildCsp({ app: "web", nonce: "n", env: {}, allow: { [kind]: [v] } })).toThrow(/Invalid CSP source/);
      }),
      opts,
    );
  });

  it("nonces outside the base64/base64url alphabet throw (no quote/semicolon smuggling)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => /[^A-Za-z0-9+/_=-]/.test(s)), (n) => {
        expect(() => buildCsp({ app: "web", nonce: n, env: {} })).toThrow("Invalid CSP nonce");
      }),
      opts,
    );
  });

  it("reportUri: default path, custom path, false disables, injection throws", () => {
    const env = { NODE_ENV: "production" };
    expect(parse(buildCsp({ app: "web", env })).get("report-uri")).toEqual([CSP_REPORT_PATH]);
    expect(parse(buildCsp({ app: "web", env })).get("report-to")).toEqual(["csp"]);
    expect(parse(buildCsp({ app: "web", env, reportUri: "/r" })).get("report-uri")).toEqual(["/r"]);
    const off = parse(buildCsp({ app: "web", env, reportUri: false }));
    expect(off.has("report-uri") || off.has("report-to")).toBe(false);
    expect(() => buildCsp({ app: "web", env, reportUri: "/r; script-src *" })).toThrow();
  });
});

describe("buildCsp: integrations", () => {
  const prod = { NODE_ENV: "production" };
  it("Turnstile defaults on for web/seller with a site key only; forms option overrides", () => {
    const key = { ...prod, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" };
    for (const app of ["web", "seller"] as const) expect(buildCsp({ app, env: key })).toContain("challenges.cloudflare.com");
    for (const app of ["admin", "studio", "api"] as const) expect(buildCsp({ app, env: key })).not.toContain("challenges.cloudflare.com");
    expect(buildCsp({ app: "web", env: prod })).not.toContain("challenges.cloudflare.com");
    expect(buildCsp({ app: "admin", env: prod, forms: true })).toContain("challenges.cloudflare.com");
    expect(buildCsp({ app: "web", env: key, forms: false })).not.toContain("challenges.cloudflare.com");
  });
  it("Clarity is web-only even when forced; media origin (not path) is granted to img/media only", () => {
    expect(buildCsp({ app: "seller", env: { ...prod, NEXT_PUBLIC_CLARITY_PROJECT_ID: "c" }, analytics: true })).not.toContain("clarity");
    const d = parse(buildCsp({ app: "web", env: { ...prod, MEDIA_PUBLIC_BASE_URL: "https://media.example.in/public/x" } }));
    expect(d.get("img-src")).toContain("https://media.example.in");
    expect(d.get("media-src")).toContain("https://media.example.in");
    expect(d.get("script-src")).not.toContain("https://media.example.in");
    expect(d.get("connect-src")).not.toContain("https://media.example.in");
  });
  it("junk MEDIA/SENTRY URLs are ignored rather than emitted", () => {
    const csp = buildCsp({ app: "web", env: { ...prod, MEDIA_PUBLIC_BASE_URL: "not a url", NEXT_PUBLIC_SENTRY_DSN: "junk" } });
    expect(csp).not.toContain("not a url");
    expect(csp).not.toContain("junk");
  });
  it("uses process.env by default", () => {
    const before = process.env.NODE_ENV;
    expect(parse(buildCsp({ app: "web" })).has("upgrade-insecure-requests")).toBe(before === "production");
  });
});

describe("originOf / sentryOrigin / isReportOnly", () => {
  it("originOf", () => {
    expect(originOf("https://a.b.c:8443/x?y#z")).toBe("https://a.b.c:8443");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("data:text/plain,x")).toBeNull(); // opaque origin
    expect(originOf("javascript:alert(1)")).toBeNull();
  });
  it("sentryOrigin prefers the public DSN, falls back to the server DSN, strips the key", () => {
    expect(sentryOrigin({ NEXT_PUBLIC_SENTRY_DSN: "https://pub@o1.ingest.sentry.io/2", SENTRY_DSN: "https://srv@o9.ingest.sentry.io/3" })).toBe("https://o1.ingest.sentry.io");
    expect(sentryOrigin({ SENTRY_DSN: "https://srv@o9.ingest.sentry.io/3" })).toBe("https://o9.ingest.sentry.io");
    expect(sentryOrigin({})).toBeNull();
  });
  it("isReportOnly only for 1/true", () => {
    expect([isReportOnly({ CSP_REPORT_ONLY: "1" }), isReportOnly({ CSP_REPORT_ONLY: "true" }), isReportOnly({ CSP_REPORT_ONLY: "0" }), isReportOnly({}), isReportOnly({ CSP_REPORT_ONLY: "TRUE" })]).toEqual([true, true, false, false, false]);
    const prev = process.env.CSP_REPORT_ONLY;
    delete process.env.CSP_REPORT_ONLY;
    expect(isReportOnly()).toBe(false);
    if (prev !== undefined) process.env.CSP_REPORT_ONLY = prev;
  });
});

describe("securityHeaders per app", () => {
  const prod = { NODE_ENV: "production" };
  const expected: Record<SecurityApp, { xfo: string; referrer: string; noindex: boolean }> = {
    web: { xfo: "SAMEORIGIN", referrer: "strict-origin-when-cross-origin", noindex: false },
    seller: { xfo: "DENY", referrer: "strict-origin-when-cross-origin", noindex: true },
    admin: { xfo: "DENY", referrer: "no-referrer", noindex: true },
    studio: { xfo: "DENY", referrer: "strict-origin-when-cross-origin", noindex: true },
    api: { xfo: "DENY", referrer: "strict-origin-when-cross-origin", noindex: false },
  };
  it.each(apps)("%s", (app) => {
    const h = securityHeaders({ app, nonce: "n", env: prod });
    expect(h["X-Frame-Options"]).toBe(expected[app].xfo);
    expect(h["Referrer-Policy"]).toBe(expected[app].referrer);
    expect(h["X-Robots-Tag"] !== undefined).toBe(expected[app].noindex);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Origin-Agent-Cluster"]).toBe("?1");
    expect(h["X-Permitted-Cross-Domain-Policies"]).toBe("none");
    expect(h["Reporting-Endpoints"]).toBe(`csp="${CSP_REPORT_PATH}"`);
    expect(h["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(Object.keys(h).filter((k) => k.startsWith("Content-Security-Policy"))).toHaveLength(1);
    // X-Frame-Options and CSP frame-ancestors agree
    expect(h["Content-Security-Policy"]!.includes("frame-ancestors 'self'")).toBe(app === "web");
  });
  it("permissions policy: everything denied by default; only the requested features are opened to self", () => {
    const deny = securityHeaders({ app: "web", env: prod })["Permissions-Policy"]!;
    for (const f of ["camera", "microphone", "geolocation", "payment", "usb", "serial", "bluetooth", "interest-cohort"]) expect(deny).toContain(`${f}=()`);
    const open = securityHeaders({ app: "web", env: prod, camera: true, microphone: true, geolocation: true })["Permissions-Policy"]!;
    expect(open).toContain("camera=(self)");
    expect(open).toContain("microphone=(self)");
    expect(open).toContain("geolocation=(self)");
    expect(open).toContain("payment=()");
  });
  it("reportOnly option beats the env; reportUri false drops Reporting-Endpoints; custom uri is used", () => {
    expect(securityHeaders({ app: "web", env: { CSP_REPORT_ONLY: "1" }, reportOnly: false })["Content-Security-Policy"]).toBeTruthy();
    expect(securityHeaders({ app: "web", env: {}, reportOnly: true })["Content-Security-Policy-Report-Only"]).toBeTruthy();
    expect(securityHeaders({ app: "web", env: {}, reportUri: false })["Reporting-Endpoints"]).toBeUndefined();
    expect(securityHeaders({ app: "web", env: {}, reportUri: "/custom" })["Reporting-Endpoints"]).toBe('csp="/custom"');
  });
  it("staticHeaderList mirrors securityHeaders (static mode: no nonce)", () => {
    const list = staticHeaderList({ app: "seller", env: prod });
    expect(Object.fromEntries(list.map((x) => [x.key, x.value]))).toEqual(securityHeaders({ app: "seller", env: prod }));
    expect(list.find((x) => x.key === "Content-Security-Policy")!.value).not.toContain("nonce-");
  });
  it("no header value ever contains CR/LF (header injection)", () => {
    for (const app of apps) for (const v of Object.values(securityHeaders({ app, nonce: "abc", env: prod }))) expect(v).not.toMatch(/[\r\n]/);
  });
});
