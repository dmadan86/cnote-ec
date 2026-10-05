import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAccountConsent, readClientConsent, rejectAll, syncFromAccount, type ConsentConfig, type ConsentEnv, type ConsentReceiptBody } from "../src/client";
import { firstParty } from "../src";

const NOW = Date.parse("2026-09-30T00:00:00Z");
const nowSec = Math.floor(NOW / 1000);
const CFG: ConsentConfig = {
  cookieName: "app_consent",
  policyVersion: 2,
  pendingKey: "app_consent_pending",
  receiptPath: "/api/consent",
  registry: [firstParty("app_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 })],
};
const SYNC = { syncKey: "app_sync", accountPath: "/api/consent/account" };

function fakeEnv() {
  const jar = new Map<string, string>();
  const receipts: ConsentReceiptBody[] = [];
  const session: string[] = [];
  let pending: ConsentReceiptBody[] = [];
  const env: ConsentEnv = {
    getCookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    setCookie: (c) => {
      const [pair = "", ...attrs] = c.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    },
    removeLocal: () => undefined,
    removeSession: () => undefined,
    hostname: () => "localhost",
    secure: () => false,
    gpc: () => false,
    now: () => NOW,
    emit: () => undefined,
    postReceipt: async (b) => {
      receipts.push(b);
      return 200;
    },
    readPending: () => [...pending],
    writePending: (l) => void (pending = [...l]),
    readSession: () => null,
    writeSession: (_k, v) => void session.push(v),
  };
  return { env, receipts, session };
}

afterEach(() => vi.restoreAllMocks());

describe("syncFromAccount", () => {
  it("adopts the ledger on a device with no cookie, marks the visit as synced and records the action", async () => {
    const f = fakeEnv();
    const account = {
      signedIn: true,
      analytics: { granted: true, at: nowSec - 10 },
      marketing: { granted: true, at: nowSec - 10 },
      functional: { granted: true, at: nowSec - 10 },
    };
    expect(await syncFromAccount(CFG, SYNC, "en", f.env, async () => account)).toBe(true);
    expect(f.session).toEqual(["1"]);
    expect(readClientConsent(CFG, f.env)).toMatchObject({ analytics: true, marketing: true, functional: true });
    expect(f.receipts.at(-1)).toMatchObject({ action: "accept_all" });
  });

  it("by default fetches the app's account path", async () => {
    const f = fakeEnv();
    const body = { signedIn: true, analytics: { granted: true, at: nowSec - 5 }, marketing: null };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    expect(await syncFromAccount(CFG, SYNC, "en", f.env)).toBe(true);
    expect(spy).toHaveBeenCalledWith("/api/consent/account", expect.anything());
    expect(readClientConsent(CFG, f.env)).toMatchObject({ analytics: true, marketing: false });
  });

  it("skips the request when the cookie exists and this visit was already checked", async () => {
    const f = fakeEnv();
    rejectAll(CFG, "en", f.env);
    f.env.readSession = () => "1";
    const load = vi.fn(async () => null);
    expect(await syncFromAccount(CFG, SYNC, "en", f.env, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("returns false when the account cannot be loaded, and for anonymous visitors (marked 0)", async () => {
    const f = fakeEnv();
    expect(await syncFromAccount(CFG, SYNC, "en", f.env, async () => null)).toBe(false);
    expect(f.session).toEqual([]);
    expect(await syncFromAccount(CFG, SYNC, "en", f.env, async () => ({ signedIn: false, analytics: null, marketing: null }))).toBe(false);
    expect(f.session).toEqual(["0"]);
  });
});

describe("loadAccountConsent", () => {
  it("returns the body on 200 and null on non-ok or network failure", async () => {
    const body = { signedIn: true, analytics: null, marketing: null };
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    expect(await loadAccountConsent("/x")).toEqual(body);
    expect(spy).toHaveBeenCalledWith("/x", { credentials: "same-origin", cache: "no-store" });
    spy.mockResolvedValueOnce(new Response("no", { status: 500 }));
    expect(await loadAccountConsent("/x")).toBeNull();
    spy.mockRejectedValueOnce(new Error("offline"));
    expect(await loadAccountConsent("/x")).toBeNull();
  });
});
