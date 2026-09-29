// GSTN provider adapters with a mocked fetch: timeouts, 5xx retry/backoff, circuit breaker (open / half-open), parsing.
import { redis } from "@cnote/core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GstnProviderError, gstinCheckChar, type GstnProvider } from "../src/gstin";
import {
  cashfreeProvider, createMockGstnProvider, parseCashfree, parseSurepass, parseSurepassFilings, providerFromEnv, surepassProvider, withCircuitBreaker, mockProvider,
} from "../src/gst/providers";

const mk = (state: string, pan: string, code = "1") => { const f = `${state}${pan}${code}Z`; return f + gstinCheckChar(f); };
const G = mk("27", "AAPFU0939F");
const env = (o: Record<string, string> = {}) => ({ GST_PROVIDER_KEY: "key", GST_PROVIDER_SECRET: "secret", ...o }) as NodeJS.ProcessEnv;

type Step = { status?: number; body?: unknown; text?: string; throws?: Error; hang?: boolean };
function stubFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s.throws) throw s.throws;
    if (s.hang) return new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return new Response(s.text ?? JSON.stringify(s.body ?? {}), { status: s.status ?? 200 });
  }));
  return calls;
}
/** run a lookup to completion with fake setTimeout (backoff + abort timers) */
async function run<T>(p: Promise<T>): Promise<T | unknown> {
  let done = false;
  const settled = p.then((v) => v, (e) => e).finally(() => { done = true; });
  for (let i = 0; i < 500 && !done; i++) {
    await vi.advanceTimersByTimeAsync(500);
    await new Promise((r) => setImmediate(r)); // let Redis I/O progress (setImmediate is not faked)
  }
  return settled;
}
const CB = ["cashfree", "surepass"].flatMap((n) => [`gstn:cb:${n}:open`, `gstn:cb:${n}:fails`]);
const cleanCb = async () => { await redis.del(...CB); };

beforeEach(async () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); await cleanCb(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(cleanCb);

const okCashfree = { valid: true, legal_name_of_business: "ACME LTD", trade_name_of_business: "Acme", gst_in_status: "Active", date_of_registration: "2018-07-01", taxpayer_type: "Regular", constitution_of_business: "Private Limited Company", state_jurisdiction: "Pune", principal_place_address: "Plot 1", principal_place_split_address: { city: "Pune", state: "Maharashtra", pincode: "411019" } };

describe("mock provider", () => {
  it("13th char steers behaviour: C/S/M/N/U/F and fixtures", async () => {
    const m = createMockGstnProvider();
    expect((await m.lookup(mk("27", "AAPFU0939F", "C"), { businessName: "Foo" }))?.status).toBe("Cancelled");
    expect((await m.lookup(mk("27", "AAPFU0939F", "S")))?.status).toBe("Suspended");
    expect((await m.lookup(mk("27", "AAPFU0939F", "M"), { businessName: "Foo" }))?.legalName).toContain("Completely Different");
    expect(await m.lookup(mk("27", "AAPFU0939F", "N"))).toBeNull();
    await expect(m.lookup(mk("27", "AAPFU0939F", "U"))).rejects.toMatchObject({ kind: "unavailable" });
    const f = await m.lookup(mk("27", "AAPFU0939F", "F"));
    expect(f?.filings?.filter((x) => x.filed)).toHaveLength(2);
    const ok = await m.lookup(G, { businessName: " Echo Name " });
    expect(ok).toMatchObject({ legalName: "Echo Name", tradeName: "Echo Name", status: "Active", state: "Maharashtra" });
    expect(ok?.filings).toHaveLength(6);
    expect((await m.lookup(G))?.legalName).toBe("AAPFU0939F Enterprises Pvt Ltd");
    m.setFixture(G, null);
    expect(await m.lookup(G)).toBeNull();
    m.setFixture(G, { legalName: "Pinned", state: null, status: "Inactive" });
    expect((await m.lookup(G))?.legalName).toBe("Pinned");
    m.clearFixtures();
    expect((await m.lookup(G))?.status).toBe("Active");
    expect(mockProvider.name).toBe("mock");
  });
});

describe("providerFromEnv", () => {
  it("selects by GST_PROVIDER (case-insensitive), defaults to mock, rejects unknown", () => {
    expect(providerFromEnv({} as NodeJS.ProcessEnv).name).toBe("mock");
    expect(providerFromEnv({ GST_PROVIDER: "MOCK" } as NodeJS.ProcessEnv).name).toBe("mock");
    expect(providerFromEnv({ GST_PROVIDER: "Cashfree" } as NodeJS.ProcessEnv).name).toBe("cashfree");
    expect(providerFromEnv({ GST_PROVIDER: "surepass" } as NodeJS.ProcessEnv).name).toBe("surepass");
    expect(() => providerFromEnv({ GST_PROVIDER: "gstn-direct" } as NodeJS.ProcessEnv)).toThrow(/Unknown GST_PROVIDER/);
  });
});

describe("cashfree adapter", () => {
  it("POSTs credentials in headers (not the URL/body), truncates the business name and maps the record", async () => {
    const calls = stubFetch([{ body: okCashfree }]);
    const rec = await cashfreeProvider(env({ GST_PROVIDER_BASE_URL: "https://cf.test" })).lookup(G, { businessName: "N".repeat(300) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://cf.test/verification/gstin");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ "x-client-id": "key", "x-client-secret": "secret" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.GSTIN).toBe(G);
    expect(body.business_name).toHaveLength(200);
    expect(calls[0]!.url).not.toContain("secret");
    expect(rec).toMatchObject({ legalName: "ACME LTD", tradeName: "Acme", status: "Active", state: "Maharashtra", registrationDate: "2018-07-01", principalAddress: { city: "Pune", pincode: "411019", line: "Plot 1" } });
  });
  it("omits business_name when none is given and uses the default base URL", async () => {
    const calls = stubFetch([{ body: okCashfree }]);
    await cashfreeProvider(env()).lookup(G);
    expect(calls[0]!.url).toBe("https://api.cashfree.com/verification/gstin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ GSTIN: G });
  });
  it("missing credentials => auth error, no network call, not counted against the breaker", async () => {
    const calls = stubFetch([{ body: okCashfree }]);
    for (let i = 0; i < 7; i++) await expect(cashfreeProvider({} as NodeJS.ProcessEnv).lookup(G)).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(0);
    expect(await redis.exists("gstn:cb:cashfree:open")).toBe(0);
  });
  it("not-found style responses resolve to null", async () => {
    for (const s of [{ status: 400, body: {} }, { status: 404, body: {} }, { status: 200, body: { valid: false } }]) {
      stubFetch([s]);
      expect(await cashfreeProvider(env()).lookup(G)).toBeNull();
    }
  });
  it("auth failures (401/403/insufficient balance) surface as kind=auth without retry", async () => {
    for (const s of [{ status: 401 }, { status: 403 }, { status: 422, body: { code: "insufficient_balance" } }]) {
      const calls = stubFetch([s]);
      await expect(cashfreeProvider(env()).lookup(G)).rejects.toMatchObject({ kind: "auth" });
      expect(calls).toHaveLength(1);
    }
  });
  it("5xx is retried with backoff (3 attempts) then reported as unavailable", async () => {
    const calls = stubFetch([{ status: 503, body: {} }]);
    const err = await run(cashfreeProvider(env()).lookup(G));
    expect(err).toMatchObject({ kind: "unavailable", message: expect.stringContaining("503") });
    expect(calls).toHaveLength(3);
  });
  it("a transient 5xx followed by a success recovers", async () => {
    const calls = stubFetch([{ status: 502 }, { status: 200, body: okCashfree }]);
    const rec = await run(cashfreeProvider(env()).lookup(G));
    expect(rec).toMatchObject({ legalName: "ACME LTD" });
    expect(calls).toHaveLength(2);
    expect(await redis.exists("gstn:cb:cashfree:fails")).toBe(0); // success clears the failure counter
  });
  it("timeout: aborts after GST_PROVIDER_TIMEOUT_MS, retries, then kind=timeout", async () => {
    const calls = stubFetch([{ hang: true }]);
    const err = await run(cashfreeProvider(env({ GST_PROVIDER_TIMEOUT_MS: "1500" })).lookup(G));
    expect(err).toMatchObject({ kind: "timeout", message: expect.stringContaining("1500ms") });
    expect(calls).toHaveLength(3);
  });
  it("network errors are retried and wrapped as unavailable", async () => {
    const calls = stubFetch([{ throws: new TypeError("fetch failed") }]);
    const err = await run(cashfreeProvider(env()).lookup(G));
    expect(err).toBeInstanceOf(GstnProviderError);
    expect(err).toMatchObject({ kind: "unavailable", message: expect.stringContaining("fetch failed") });
    expect(calls).toHaveLength(3);
  });
  it("429 and non-JSON are NOT retried; unexpected statuses are bad_response", async () => {
    let calls = stubFetch([{ status: 429 }]);
    expect(await run(cashfreeProvider(env()).lookup(G))).toMatchObject({ kind: "rate_limited" });
    expect(calls).toHaveLength(1);
    calls = stubFetch([{ text: "<html>oops</html>" }]);
    expect(await run(cashfreeProvider(env()).lookup(G))).toMatchObject({ kind: "bad_response" });
    expect(calls).toHaveLength(1);
    calls = stubFetch([{ status: 418, body: {} }]);
    expect(await run(cashfreeProvider(env()).lookup(G))).toMatchObject({ kind: "bad_response" });
  });
  it("empty body on a 200 is handled", async () => {
    stubFetch([{ text: "" }]);
    expect(await cashfreeProvider(env()).lookup(G)).toMatchObject({ legalName: "", status: "Inactive" });
  });
});

describe("circuit breaker", () => {
  it("opens after 5 infra failures: further calls fail fast with circuit_open and do not hit the network", async () => {
    const calls = stubFetch([{ status: 500 }]);
    const p = cashfreeProvider(env());
    for (let i = 0; i < 5; i++) expect(await run(p.lookup(G))).toMatchObject({ kind: "unavailable" });
    expect(calls).toHaveLength(15);
    expect(await redis.exists("gstn:cb:cashfree:open")).toBe(1);
    expect(await redis.ttl("gstn:cb:cashfree:open")).toBeLessThanOrEqual(60);
    expect(await run(p.lookup(G))).toMatchObject({ kind: "circuit_open" });
    expect(calls).toHaveLength(15);
    // breaker is per provider
    stubFetch([{ body: { success: true, data: { legal_name: "S" } } }]);
    expect(await surepassProvider(env()).lookup(G)).toMatchObject({ legalName: "S" });
  });
  it("4 failures do not open it; a success in between resets the counter", async () => {
    stubFetch([{ status: 500 }]);
    const p = cashfreeProvider(env());
    for (let i = 0; i < 4; i++) await run(p.lookup(G));
    expect(await redis.exists("gstn:cb:cashfree:open")).toBe(0);
    stubFetch([{ body: okCashfree }]);
    await p.lookup(G);
    stubFetch([{ status: 500 }]);
    for (let i = 0; i < 4; i++) await run(p.lookup(G));
    expect(await redis.exists("gstn:cb:cashfree:open")).toBe(0);
  });
  it("half-open: when the open window lapses one probe goes through; success closes, failure re-trips immediately", async () => {
    stubFetch([{ status: 500 }]);
    const p = cashfreeProvider(env());
    for (let i = 0; i < 5; i++) await run(p.lookup(G));
    await redis.del("gstn:cb:cashfree:open"); // window lapsed
    let calls = stubFetch([{ status: 500 }]);
    expect(await run(p.lookup(G))).toMatchObject({ kind: "unavailable" }); // probe let through, failed (counter still hot)
    expect(calls.length).toBeGreaterThan(0);
    expect(await redis.exists("gstn:cb:cashfree:open")).toBe(1);
    await redis.del("gstn:cb:cashfree:open");
    calls = stubFetch([{ body: okCashfree }]);
    expect(await p.lookup(G)).toMatchObject({ legalName: "ACME LTD" });
    expect(await redis.exists("gstn:cb:cashfree:fails")).toBe(0);
    expect(await redis.exists("gstn:cb:cashfree:open")).toBe(0);
  });
  it("only infrastructure kinds count (timeout/unavailable/bad_response); auth, rate_limited, not-found and unknown errors do not", async () => {
    const name = `t-${Math.random()}`;
    const fail = (kind: GstnProviderError["kind"]) => withCircuitBreaker(name, async () => { throw new GstnProviderError(kind, kind); }).catch(() => {});
    for (let i = 0; i < 10; i++) { await fail("auth"); await fail("rate_limited"); }
    await withCircuitBreaker(name, async () => { throw new Error("programming bug"); }).catch(() => {});
    expect(await redis.exists(`gstn:cb:${name}:fails`)).toBe(0);
    for (const k of ["timeout", "unavailable", "bad_response", "timeout", "unavailable"] as const) await fail(k);
    expect(await redis.exists(`gstn:cb:${name}:open`)).toBe(1);
    await expect(withCircuitBreaker(name, async () => "x")).rejects.toMatchObject({ kind: "circuit_open" });
    await redis.del(`gstn:cb:${name}:open`, `gstn:cb:${name}:fails`);
  });
  it("the failure window expires (counter has a 60s TTL)", async () => {
    const name = `t-${Math.random()}`;
    await withCircuitBreaker(name, async () => { throw new GstnProviderError("timeout", "t"); }).catch(() => {});
    const ttl = await redis.ttl(`gstn:cb:${name}:fails`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await redis.del(`gstn:cb:${name}:fails`);
  });
  it("Redis outages never block verification and never mask the real error", async () => {
    vi.spyOn(redis, "exists").mockRejectedValue(new Error("redis down"));
    vi.spyOn(redis, "incr").mockRejectedValue(new Error("redis down"));
    vi.spyOn(redis, "del").mockRejectedValue(new Error("redis down"));
    await expect(withCircuitBreaker("x", async () => 42)).resolves.toBe(42);
    await expect(withCircuitBreaker("x", async () => { throw new GstnProviderError("timeout", "boom"); })).rejects.toMatchObject({ message: "boom" });
  });
});

describe("surepass adapter + parsers", () => {
  it("uses bearer auth, needs a token, maps the record incl. HSN codes", async () => {
    await expect(surepassProvider({} as NodeJS.ProcessEnv).lookup(G)).rejects.toMatchObject({ kind: "auth" });
    const calls = stubFetch([{ body: { success: true, data: { legal_name: "Y Pvt Ltd", business_name: "Y Trade", gstin_status: "Active", address_details: { address: "Addr", city: "Pune", state: "MH", pincode: "411001" }, hsn_info: [{ hsn_no: "7208" }, "7209", { hsn_no: "" }], constitutional_of_business: "LLP", date_of_registration: "01/07/2017" } } }]);
    const rec = await surepassProvider(env({ GST_PROVIDER_BASE_URL: "https://sp.test" })).lookup(G);
    expect(calls[0]!.url).toBe("https://sp.test/api/v1/corporate/gstin");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer key" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ id_number: G });
    expect(rec).toMatchObject({ legalName: "Y Pvt Ltd", tradeName: "Y Trade", constitution: "LLP", registrationDate: "2017-07-01", hsnCodes: ["7208", "7209"], principalAddress: { line: "Addr", city: "Pune", pincode: "411001" } });
  });
  it("fetches GSTR-3B filings only when GST_PROVIDER_FILINGS=1, and ignores failures of that optional call", async () => {
    let calls = stubFetch([{ body: { success: true, data: { legal_name: "Y" } } }, { body: { data: { filing_status: [[{ return_type: "GSTR3B", return_period: "052026", status: "Filed", date_of_filing: "2026-06-19" }, { return_type: "GSTR3B", return_period: "062026", status: "Not Filed" }, { return_type: "GSTR1", return_period: "062026", status: "Filed" }]] } } }]);
    const p = surepassProvider(env({ GST_PROVIDER_FILINGS: "1" }));
    const rec = await p.lookup(G);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("gst-return-status");
    expect(JSON.parse(String(calls[1]!.init.body)).financial_year).toMatch(/^\d{4}-\d{2}$/);
    expect(rec!.filings).toEqual([{ period: "2026-06", filed: false, filedOn: undefined }, { period: "2026-05", filed: true, filedOn: "2026-06-19" }]);
    calls = stubFetch([{ body: { success: true, data: { legal_name: "Y" } } }, { status: 429 }]);
    const noFilings = (await run(surepassProvider(env({ GST_PROVIDER_FILINGS: "1" })).lookup(G))) as { legalName: string; filings?: unknown };
    expect(noFilings.legalName).toBe("Y");
    expect(noFilings.filings).toBeUndefined();
    calls = stubFetch([{ body: { success: true, data: { legal_name: "Y" } } }]);
    await surepassProvider(env()).lookup(G);
    expect(calls).toHaveLength(1);
  });
  it("parseSurepass status handling", () => {
    expect(() => parseSurepass(401, {}, G)).toThrow(/auth/);
    expect(() => parseSurepass(403, {}, G)).toThrow(/auth/);
    expect(parseSurepass(422, {}, G)).toBeNull();
    expect(parseSurepass(404, {}, G)).toBeNull();
    expect(parseSurepass(200, { success: false }, G)).toBeNull();
    expect(() => parseSurepass(500, {}, G)).toThrow(/HTTP 500/);
    expect(parseSurepass(200, null, G)).toMatchObject({ legalName: "", status: "Inactive" });
    expect(parseSurepass(200, { data: { principal_address: { address: "A" }, address: "Top", status: "cancelled", trade_name: "T" } }, G)).toMatchObject({ status: "Cancelled", tradeName: "T", principalAddress: { line: "Top" } });
  });
  it("parseCashfree status handling + status/date mapping", () => {
    expect(() => parseCashfree(401, { code: "x" }, G)).toThrow(/auth failed \(x\)/);
    expect(() => parseCashfree(403, null, G)).toThrow(/403/);
    expect(() => parseCashfree(422, { code: "insufficient_balance" }, G)).toThrow(/balance/);
    expect(() => parseCashfree(422, {}, G)).toThrow(/HTTP 422/);
    expect(() => parseCashfree(500, {}, G)).toThrow(/HTTP 500/);
    for (const [s, want] of [["Active", "Active"], ["ACTIVE ", "Active"], ["Cancelled", "Cancelled"], ["Suspended", "Suspended"], ["Provisional", "Inactive"], [undefined, "Inactive"]] as const)
      expect(parseCashfree(200, { gst_in_status: s }, G)?.status).toBe(want);
    expect(parseCashfree(200, { date_of_registration: "30/09/2017" }, G)?.registrationDate).toBe("2017-09-30");
    expect(parseCashfree(200, { date_of_registration: "30-09-2017" }, G)?.registrationDate).toBe("2017-09-30");
    expect(parseCashfree(200, { date_of_registration: "2017-09-30T00:00:00" }, G)?.registrationDate).toBe("2017-09-30");
    expect(parseCashfree(200, { date_of_registration: "garbage" }, G)?.registrationDate).toBeUndefined();
    expect(parseCashfree(200, { principal_place_split_address: { district: "D" } }, G)?.principalAddress?.city).toBe("D");
    expect(parseCashfree(200, {}, "99AAPFU0939F1ZV")?.state).toBeNull();
  });
  it("parseSurepassFilings ignores non-3B rows and malformed periods; undefined when empty", () => {
    expect(parseSurepassFilings(null)).toBeUndefined();
    expect(parseSurepassFilings({ data: { filing_status: [] } })).toBeUndefined();
    expect(parseSurepassFilings({ data: { filing_status: [{ rtype: "gstr3b", ret_prd: "012026", status: "filed", dof: "15/02/2026" }, { return_type: "GSTR3B", return_period: "bad" }, { return_type: "GSTR9" }] } })).toEqual([{ period: "2026-01", filed: true, filedOn: "2026-02-15" }]);
  });
});

it("type sanity: adapters satisfy GstnProvider", () => {
  const p: GstnProvider = cashfreeProvider(env());
  expect(typeof p.lookup).toBe("function");
});
