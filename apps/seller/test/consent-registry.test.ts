import path from "node:path";
import { describe, expect, it } from "vitest";
import { cookieNames } from "@cnote/identity";
import { entriesOf, optionalEntries, stripCookiePrefix } from "@cnote/consent";
import { findIframes, findQuotedKeys, findScriptLoads, findStorageWrites, read, sourceFiles } from "@cnote/consent/testing";
import { SELLER_STORAGE_REGISTRY } from "@/features/consent/registry";

const SRC = path.join(__dirname, "..", "src");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const names = SELLER_STORAGE_REGISTRY.map((e) => e.name);
const files = sourceFiles(SRC);
/** Quoted `seller_*` strings that are NOT storage keys: purpose "source" labels and purposes of the identity consent ledger. */
const NOT_STORAGE = new Set(["seller_portal", "seller_onboarding", "seller_settings", "seller_cookie_banner", "seller_analytics_cookies", "seller_marketing_cookies"]);

describe("seller cookie registry (single source of truth)", () => {
  it("has unique names and only known categories; every entry has a purpose", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const e of SELLER_STORAGE_REGISTRY) {
      expect(["necessary", "analytics", "marketing"]).toContain(e.category); // no functional storage in this app (a switch would control nothing)
      expect(e.purpose.length).toBeGreaterThan(0);
    }
  });

  it("lists every seller_* / cnote_seller_* cookie or storage key quoted anywhere in the app source", () => {
    const found = new Map<string, string>();
    for (const f of files) for (const k of findQuotedKeys(read(f), /seller_|cnote_seller_/)) found.set(stripCookiePrefix(k.key), rel(f));
    const missing = [...found].filter(([k]) => !names.includes(k) && !NOT_STORAGE.has(k)).map(([k, f]) => `${k} (${f})`);
    expect(missing, "add these to src/features/consent/registry.ts (and see docs/design/cookie-consent.md)").toEqual([]);
    // the scan actually sees the important ones (guards against a broken regex / moved sources)
    for (const k of ["seller_consent", "seller_locale", "seller_ref", "seller_onb_t0", "seller_onb_t1", "seller_onb_done"]) expect(found.has(k), k).toBe(true);
  });

  it("covers the auth cookies the shared next-kit writes for this realm (names, with the production __Host- prefix stripped)", () => {
    const { access, refresh } = cookieNames("seller", true);
    for (const k of [stripCookiePrefix(access), stripCookiePrefix(refresh), "cnote_seller_oauth", "cnote_seller_mfa"]) expect(names, k).toContain(k);
  });

  it("classifies onboarding timing as analytics, the referral code as marketing, and the user's own actions as strictly necessary", () => {
    const cat = (n: string) => SELLER_STORAGE_REGISTRY.find((e) => e.name === n)?.category;
    expect(cat("seller_onb_t0")).toBe("analytics");
    expect(cat("seller_ref")).toBe("marketing");
    for (const n of ["seller_consent", "seller_consent_pending", "seller_consent_sync", "seller_locale", "seller_onb_done", "seller_onb_skip_gst", "seller_onb_skip_listing", "seller_onb_t1", "cnote_seller_at", "cnote_seller_rt"]) expect(cat(n), n).toBe("necessary");
    expect(optionalEntries(SELLER_STORAGE_REGISTRY).map((e) => e.name).sort()).toEqual(["seller_onb_t0", "seller_ref"]);
    expect(entriesOf(SELLER_STORAGE_REGISTRY, "functional")).toEqual([]);
  });

  it("every optional cookie is httpOnly (the server writes and expires it, so withdrawal reaches it through POST /api/consent)", () => {
    for (const e of optionalEntries(SELLER_STORAGE_REGISTRY)) expect(e.httpOnly, e.name).toBe(true);
  });
});

describe("seller storage writes and third-party loads are accounted for", () => {
  // The only files allowed to write a cookie. Optional ones are gated (see consent-gating.test.ts); the rest set strictly necessary state.
  const COOKIE_WRITERS = new Set(["lib/cookies.ts", "i18n/actions.ts", "proxy.ts", "app/api/consent/ref/route.ts"]);
  // Reads of document.cookie (never writes): the error page reads the language cookie.
  const COOKIE_READERS = new Set(["app/global-error.tsx"]);

  it("writes cookies only from the audited files, and never uses localStorage / sessionStorage / indexedDB", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) === "features/consent/registry.ts") continue; // names the storage kinds ("localStorage") as data
      for (const hit of findStorageWrites(read(f))) {
        const r = rel(f);
        const ok = hit.what === "document.cookie" ? COOKIE_READERS.has(r) : COOKIE_WRITERS.has(r);
        if (!ok) offenders.push(`${r}:${hit.line} ${hit.what}`);
      }
    }
    expect(offenders, "a new cookie/storage write must be added to the registry, gated if optional, and listed here").toEqual([]);
  });

  it("loads no third-party script and renders no iframe (Turnstile is loaded by @cnote/next-kit; Sentry by instrumentation)", () => {
    const scripts: string[] = [];
    const frames: string[] = [];
    for (const f of files) {
      for (const s of findScriptLoads(read(f))) scripts.push(`${rel(f)}:${s.line} ${s.what}`);
      for (const i of findIframes(read(f))) frames.push(`${rel(f)}:${i.line}`);
    }
    expect(scripts).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("Sentry sends no PII and records no sessions (error monitoring stores nothing in the browser)", () => {
    const client = read(path.join(SRC, "instrumentation-client.ts"));
    expect(client).toContain('sentryOptions("seller", "browser")');
    expect(client).not.toMatch(/replayIntegration|replaysSessionSampleRate|browserTracingIntegration/);
  });

  it("the cookie policy page and dialog can describe every entry: each purpose has copy in every locale, and the policy page strings exist", async () => {
    const { readFileSync } = await import("node:fs");
    for (const l of ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"]) {
      const c = (JSON.parse(readFileSync(path.join(__dirname, "..", "messages", `${l}.consent.json`), "utf8")) as { consent: Record<string, unknown> }).consent;
      for (const e of SELLER_STORAGE_REGISTRY) expect((c.purpose as Record<string, string>)[e.purpose], `${l}: purpose.${e.purpose}`).toBeTruthy();
      for (const k of ["policyTitle", "policyDescription", "versionLine", "whatBody", "categoriesBody", "tableTitle", "changeBody", "gpcBody", "grievanceBody", "grievanceLink"]) expect(c[k], `${l}: ${k}`).toBeTruthy();
      expect(c.bannerText, `${l}: banner links to the policy`).toContain("<link>");
    }
  });
});
