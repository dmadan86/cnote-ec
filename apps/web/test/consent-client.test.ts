import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptAll, applyConsent, clearCategoryStorage, clientGranted, CONSENT_SYNC_KEY, expireCookie, flushPendingReceipts, isReceiptBody, readClientConsent, rejectAll, syncFromAccount, type ConsentEnv, type ConsentReceiptBody } from "@/features/consent/client";
import type { AccountConsent } from "@/features/consent/account-sync";
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
  /** receipts the server has not acknowledged (the localStorage outbox) and the answer the fake server gives */
  let pending: ConsentReceiptBody[] = [];
  const server = { status: 200 };
  const flags = new Map<string, string>();
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
    postReceipt: async (b) => {
      receipts.push(b);
      return server.status;
    },
    readPending: () => [...pending],
    writePending: (l) => void (pending = [...l]),
    readSession: (k) => flags.get(k) ?? null,
    writeSession: (k, v) => void flags.set(k, v),
  };
  return { env, jar, local, session, writes, events, receipts, server, flags, pending: () => pending };
}

describe("applyConsent", () => {
  it("Reject all writes a denied record, emits cnote:consent, and posts a reject_all receipt", () => {
    const f = fakeEnv();
    const s = rejectAll("en", f.env);
    expect(s).toMatchObject({ analytics: false, marketing: false, functional: false });
    expect(readClientConsent(f.env)).toMatchObject({ analytics: false, marketing: false, id: s.id });
    expect(f.events).toEqual([s]);
    expect(f.receipts).toEqual([{ consentId: s.id, policyVersion: s.version, analytics: false, marketing: false, functional: false, gpc: false, action: "reject_all", locale: "en", at: s.at }]);
    expect(f.jar.has(CONSENT_COOKIE)).toBe(true);
  });
  it("Accept all grants both categories; with GPC on it grants analytics only and records gpc", () => {
    const a = fakeEnv();
    expect(acceptAll("hi", a.env)).toMatchObject({ analytics: true, marketing: true, functional: true, gpc: false });
    expect(a.receipts[0]).toMatchObject({ action: "accept_all", locale: "hi", marketing: true, functional: true });
    const g = fakeEnv({ gpc: true });
    expect(acceptAll("en", g.env)).toMatchObject({ analytics: true, marketing: false, functional: true, gpc: true }); // GPC switches marketing off, never functional
    expect(g.receipts[0]).toMatchObject({ action: "accept_all", marketing: false, functional: true, gpc: true });
  });
  it("a user can still explicitly switch marketing on despite GPC (custom choice)", () => {
    const g = fakeEnv({ gpc: true });
    expect(applyConsent({ analytics: false, marketing: true, functional: false }, "custom", "en", g.env)).toMatchObject({ marketing: true, functional: false, gpc: true });
    expect(clientGranted("marketing", g.env)).toBe(true);
  });
  it("withdrawal deletes that category's client storage and cookies (incl. Clarity's) and is recorded as withdraw", () => {
    const f = fakeEnv({ host: "www.example.in", cookies: { _clck: "x", _clsk: "y", cnote_vid: "v1", cnote_locale: "hi" }, local: ["cnote_lg_v1", "cnote_lang_suggestion_dismissed"], session: ["cnote_attr", "cnote_lg_views", "cnote_lg_session"] });
    applyConsent({ analytics: true, marketing: true, functional: false }, "custom", "en", f.env); // start from a granted state
    f.jar.set("_clck", "x");
    f.jar.set("cnote_vid", "v1");
    f.writes.length = 0;
    const s = applyConsent({ analytics: true, marketing: false, functional: false }, "custom", "en", f.env);
    expect(s.marketing).toBe(false);
    expect(f.receipts.at(-1)?.action).toBe("withdraw");
    expect(f.jar.has("cnote_vid")).toBe(false); // client-readable visitor id gone
    expect(f.local.has("cnote_lg_v1")).toBe(false);
    expect([...f.session]).toEqual([]);
    expect(f.local.has("cnote_lang_suggestion_dismissed")).toBe(true); // strictly necessary: untouched
    expect(f.jar.get("cnote_locale")).toBe("hi");
    expect(f.jar.has("_clck")).toBe(true); // analytics still granted
    applyConsent({ analytics: false, marketing: false, functional: false }, "reject_all", "en", f.env);
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

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("reliable receipts (pending outbox)", () => {
  it("stores the receipt before sending and removes it only after a 200", async () => {
    const f = fakeEnv();
    const s = acceptAll("en", f.env);
    expect(f.pending()).toHaveLength(1); // still pending until the server answered
    await settle();
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]!.at).toBe(s.at);
    expect(f.pending()).toEqual([]);
  });
  it("keeps the receipt when the network fails or the server errors, and resends it on the next load", async () => {
    for (const status of [0, 503, 429]) {
      const f = fakeEnv();
      f.server.status = status;
      const s = rejectAll("en", f.env);
      await settle();
      expect(f.pending().map((p) => p.consentId), `status ${status}`).toEqual([s.id]);
      f.server.status = 200;
      await flushPendingReceipts(f.env); // "next page load"
      expect(f.receipts.filter((r) => r.consentId === s.id)).toHaveLength(2);
      expect(f.pending()).toEqual([]);
    }
  });
  it("drops a receipt the server rejects for good (400/403/413) instead of retrying forever", async () => {
    const f = fakeEnv();
    f.server.status = 400;
    rejectAll("en", f.env);
    await settle();
    expect(f.pending()).toEqual([]);
  });
  it("never lets two different choices share the same (consentId, at), even within one second", async () => {
    const f = fakeEnv();
    const a = acceptAll("en", f.env);
    const b = rejectAll("en", f.env); // same fake clock second
    expect(b.id).toBe(a.id);
    expect(b.at).toBeGreaterThan(a.at);
    await settle();
    expect(new Set(f.receipts.map((r) => `${r.consentId}:${r.at}`)).size).toBe(2);
  });
  it("only trusts well-formed stored receipts", () => {
    expect(isReceiptBody({ consentId: "a".repeat(32), policyVersion: 1, analytics: true, marketing: false, functional: false, gpc: false, action: "custom", locale: "en", at: 1 })).toBe(true);
    for (const bad of [null, "x", {}, { consentId: "short" }, { consentId: "a".repeat(32), policyVersion: 1, analytics: true, marketing: false, functional: false, gpc: false, action: "custom", locale: "en" }]) expect(isReceiptBody(bad)).toBe(false);
  });
});

describe("syncFromAccount", () => {
  const ledger = (o: Partial<AccountConsent>): AccountConsent => ({ signedIn: true, analytics: null, marketing: null, ...o });
  const nowS = Math.floor(NOW / 1000);

  it("seeds the cookie from the ledger when this browser has no valid choice", async () => {
    const f = fakeEnv();
    const adopted = await syncFromAccount("en", f.env, async () => ledger({ analytics: { granted: true, at: nowS - 100 }, marketing: { granted: false, at: nowS - 50 } }));
    expect(adopted).toBe(true);
    expect(readClientConsent(f.env)).toMatchObject({ analytics: true, marketing: false, functional: false }); // no ledger row for functional: not granted
    expect(f.flags.get(CONSENT_SYNC_KEY)).toBe("1");
  });
  it("adopts a functional grant from the ledger like any other purpose", async () => {
    const f = fakeEnv();
    await syncFromAccount("en", f.env, async () => ledger({ functional: { granted: true, at: nowS - 10 } }));
    expect(readClientConsent(f.env)).toMatchObject({ analytics: false, marketing: false, functional: true });
  });
  it("does nothing for anonymous visitors, offline, or an empty ledger", async () => {
    expect(await syncFromAccount("en", fakeEnv().env, async () => ({ signedIn: false, analytics: null, marketing: null }))).toBe(false);
    expect(await syncFromAccount("en", fakeEnv().env, async () => null)).toBe(false);
    expect(await syncFromAccount("en", fakeEnv().env, async () => ledger({}))).toBe(false);
  });
  it("a withdrawal made elsewhere later wins over this browser's older grant", async () => {
    const f = fakeEnv();
    const mine = acceptAll("en", f.env); // cookie: both granted at NOW
    const adopted = await syncFromAccount("en", f.env, async () => ledger({ analytics: { granted: true, at: nowS - 10 }, marketing: { granted: false, at: mine.at + 60 } }));
    expect(adopted).toBe(true);
    expect(readClientConsent(f.env)).toMatchObject({ analytics: true, marketing: false, functional: true });
    expect(f.receipts.at(-1)?.action).toBe("withdraw");
    expect(f.jar.has("cnote_vid")).toBe(false);
  });
  it("an older ledger entry never overrides a newer choice made on this device, and the check runs once per visit", async () => {
    const f = fakeEnv();
    acceptAll("en", f.env);
    let calls = 0;
    const load = async () => (calls++, ledger({ analytics: { granted: false, at: nowS - 500 }, marketing: { granted: false, at: nowS - 500 } }));
    expect(await syncFromAccount("en", f.env, load)).toBe(false);
    expect(readClientConsent(f.env)).toMatchObject({ analytics: true, marketing: true, functional: true });
    expect(await syncFromAccount("en", f.env, load)).toBe(false);
    expect(calls).toBe(1);
  });
});
