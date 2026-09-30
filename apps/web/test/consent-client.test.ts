import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptAll, applyConsent, clearCategoryStorage, clientGranted, expireCookie, readClientConsent, rejectAll, type ConsentEnv, type ConsentReceiptBody } from "@/features/consent/client";
import { clientClearable, serverClearable } from "@/features/consent/registry";
import { CONSENT_COOKIE, type ConsentState } from "@/features/consent/state";

const NOW = Date.parse("2026-09-30T00:00:00Z");

/** Minimal in-memory browser: a cookie jar (name -> value), two storages, an event log and the receipt outbox. */
function fakeEnv(o: { gpc?: boolean; host?: string; cookies?: Record<string, string>; local?: string[]; session?: string[] } = {}) {
  const jar = new Map<string, string>(Object.entries(o.cookies ?? {}));
  const local = new Set(o.local ?? []);
  const session = new Set(o.session ?? []);
  const writes: string[] = [];
  const events: ConsentState[] = [];
  const receipts: ConsentReceiptBody[] = [];
  const env: ConsentEnv = {
    getCookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    setCookie: (c) => {
      writes.push(c);
      const [pair = "", ...attrs] = c.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const expired = attrs.some((a) => /^max-age=0$/i.test(a));
      if (expired) jar.delete(name);
      else jar.set(name, value);
    },
    removeLocal: (k) => void local.delete(k),
    removeSession: (k) => void session.delete(k),
    hostname: () => o.host ?? "localhost",
    secure: () => false,
    gpc: () => o.gpc ?? false,
    now: () => NOW,
    emit: (s) => void events.push(s),
    sendReceipt: (b) => void receipts.push(b),
  };
  return { env, jar, local, session, writes, events, receipts };
}

describe("applyConsent", () => {
  it("Reject all writes a denied record, emits cnote:consent, and posts a reject_all receipt", () => {
    const f = fakeEnv();
    const s = rejectAll("en", f.env);
    expect(s).toMatchObject({ analytics: false, marketing: false });
    expect(readClientConsent(f.env)).toMatchObject({ analytics: false, marketing: false, id: s.id });
    expect(f.events).toEqual([s]);
    expect(f.receipts).toEqual([{ consentId: s.id, policyVersion: s.version, analytics: false, marketing: false, gpc: false, action: "reject_all", locale: "en" }]);
    expect(f.jar.has(CONSENT_COOKIE)).toBe(true);
  });
  it("Accept all grants both categories; with GPC on it grants analytics only and records gpc", () => {
    const a = fakeEnv();
    expect(acceptAll("hi", a.env)).toMatchObject({ analytics: true, marketing: true, gpc: false });
    expect(a.receipts[0]).toMatchObject({ action: "accept_all", locale: "hi", marketing: true });
    const g = fakeEnv({ gpc: true });
    expect(acceptAll("en", g.env)).toMatchObject({ analytics: true, marketing: false, gpc: true });
    expect(g.receipts[0]).toMatchObject({ action: "accept_all", marketing: false, gpc: true });
  });
  it("a user can still explicitly switch marketing on despite GPC (custom choice)", () => {
    const g = fakeEnv({ gpc: true });
    expect(applyConsent({ analytics: false, marketing: true }, "custom", "en", g.env)).toMatchObject({ marketing: true, gpc: true });
    expect(clientGranted("marketing", g.env)).toBe(true);
  });
  it("withdrawal deletes that category's client storage and cookies (incl. Clarity's) and is recorded as withdraw", () => {
    const f = fakeEnv({ host: "www.example.in", cookies: { _clck: "x", _clsk: "y", cnote_vid: "v1", cnote_locale: "hi" }, local: ["cnote_lg_v1", "cnote_lang_suggestion_dismissed"], session: ["cnote_attr", "cnote_lg_views", "cnote_lg_session"] });
    applyConsent({ analytics: true, marketing: true }, "custom", "en", f.env); // start from a granted state
    f.jar.set("_clck", "x");
    f.jar.set("cnote_vid", "v1");
    f.writes.length = 0;
    const s = applyConsent({ analytics: true, marketing: false }, "custom", "en", f.env);
    expect(s.marketing).toBe(false);
    expect(f.receipts.at(-1)?.action).toBe("withdraw");
    expect(f.jar.has("cnote_vid")).toBe(false); // client-readable visitor id gone
    expect(f.local.has("cnote_lg_v1")).toBe(false);
    expect([...f.session]).toEqual([]);
    expect(f.local.has("cnote_lang_suggestion_dismissed")).toBe(true); // strictly necessary: untouched
    expect(f.jar.get("cnote_locale")).toBe("hi");
    expect(f.jar.has("_clck")).toBe(true); // analytics still granted
    applyConsent({ analytics: false, marketing: false }, "reject_all", "en", f.env);
    expect(f.jar.has("_clck")).toBe(false);
    expect(f.jar.has("_clsk")).toBe(false);
    expect(f.receipts.at(-1)?.action).toBe("withdraw");
    // parent domains are covered for cookies set on the registrable domain
    expect(f.writes.some((w) => w.startsWith("_clck=;") && w.includes("Domain=.example.in"))).toBe(true);
    expect(f.writes.some((w) => w.startsWith("_clck=;") && w.includes("Domain=www.example.in"))).toBe(true);
  });
  it("the consent record itself is never cleared and keeps its id across changes", () => {
    const f = fakeEnv();
    const first = acceptAll("en", f.env);
    const second = rejectAll("en", f.env);
    expect(second.id).toBe(first.id);
    expect(f.jar.has(CONSENT_COOKIE)).toBe(true);
  });
});

describe("cleanup helpers", () => {
  it("expireCookie only touches the host on localhost / IPs and never writes a bare TLD domain", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      const w: string[] = [];
      expireCookie("_clck", { setCookie: (c) => void w.push(c), hostname: () => host });
      expect(w).toHaveLength(1);
      expect(w[0]).not.toContain("Domain=");
    }
    const w: string[] = [];
    expireCookie("_clck", { setCookie: (c) => void w.push(c), hostname: () => "a.b.example.com" });
    const domains = w.map((c) => /Domain=([^;]+)/.exec(c)?.[1]).filter(Boolean);
    expect(domains).toContain("example.com");
    expect(domains).not.toContain("com");
    expect(domains).not.toContain(".com");
  });
  it("clearCategoryStorage removes every client-clearable key of the category and none from other categories", () => {
    const names = clientClearable("marketing").filter((e) => e.kind === "cookie").map((e) => e.name);
    const f = fakeEnv({ cookies: Object.fromEntries([...names, "cnote_rail"].map((n) => [n, "1"])), local: ["cnote_lg_v1", "cnote_voice_consent_v1"], session: ["cnote_attr"] });
    clearCategoryStorage("marketing", f.env);
    expect([...f.jar.keys()]).toEqual(["cnote_rail"]);
    expect(f.local.has("cnote_voice_consent_v1")).toBe(true);
    expect(f.local.has("cnote_lg_v1")).toBe(false);
  });
  it("httpOnly cookies (and the server-written twin of cnote_vid) are expired by POST /api/consent; client cleanup skips httpOnly", () => {
    expect(serverClearable("marketing").map((e) => e.name).sort()).toEqual(["cnote_ad_click", "cnote_vid"]);
    expect(serverClearable("analytics")).toEqual([]);
    expect(clientClearable("marketing").map((e) => e.name)).not.toContain("cnote_ad_click");
    expect(clientClearable("marketing").map((e) => e.name)).toContain("cnote_vid");
  });
});

describe("clientGranted without a browser", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is false on the server (no document) and reads the cookie in the browser", () => {
    expect(clientGranted("marketing")).toBe(false);
    const f = fakeEnv();
    expect(clientGranted("analytics", f.env)).toBe(false);
    acceptAll("en", f.env);
    expect(clientGranted("analytics", f.env)).toBe(true);
  });
});
