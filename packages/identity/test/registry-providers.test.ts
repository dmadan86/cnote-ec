// Udyam / MCA provider adapters: mock behaviour, Surepass HTTP handling (retries, errors), payload parsers and the env factory.
import { redis } from "@cnote/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMockMcaProvider, createMockUdyamProvider, getMcaProvider, getUdyamProvider, mockMcaProvider, mockUdyamProvider, parseSurepassMca, parseSurepassUdyam,
  setMcaProvider, setUdyamProvider, surepassMcaProvider, surepassUdyamProvider,
} from "../src";
import { SUREPASS_MCA_PATH, SUREPASS_UDYAM_PATH } from "../src/registry/providers";

const CB = ["surepass-udyam", "surepass-mca"].flatMap((n) => [`gstn:cb:${n}:open`, `gstn:cb:${n}:fails`]);
beforeEach(async () => { await redis.del(...CB); });
afterEach(async () => { await redis.del(...CB); setUdyamProvider(null); setMcaProvider(null); });

const U = "UDYAM-MH-26-0001235";
const CIN = "U12345MH2019PTC123456";
const env = (o: Record<string, string> = {}) => ({ REGISTRY_PROVIDER_KEY: "tok", REGISTRY_PROVIDER_BASE_URL: "https://vendor.test/", ...o }) as unknown as NodeJS.ProcessEnv;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("mock providers", () => {
  it("udyam: keyed on the last digit, echoes hints, fixtures win and can be cleared", async () => {
    const p = createMockUdyamProvider();
    expect(await p.lookup("UDYAM-MH-26-0000000")).toBeNull();
    await expect(p.lookup("UDYAM-MH-26-0000003")).rejects.toMatchObject({ kind: "unavailable" });
    expect((await p.lookup("UDYAM-MH-26-0000001"))?.status).toBe("Cancelled");
    expect((await p.lookup("UDYAM-MH-26-0000002"))?.enterpriseName).toBe("Completely Different Enterprises");
    const echoed = await p.lookup("UDYAM-MH-26-0000005", { businessName: "Acme", address: { city: "Pune" } });
    expect(echoed).toMatchObject({ enterpriseName: "Acme", status: "Active", address: { city: "Pune" } });
    expect(await p.lookup("UDYAM-MH-26-0000005")).toMatchObject({ enterpriseName: "Mock Enterprises", address: {} });
    p.setFixture("UDYAM-MH-26-0000005", null);
    expect(await p.lookup("UDYAM-MH-26-0000005")).toBeNull();
    p.clearFixtures();
    expect(await p.lookup("UDYAM-MH-26-0000005")).not.toBeNull();
    expect(mockUdyamProvider.name).toBe("mock");
  });
  it("mca: same conventions", async () => {
    const p = createMockMcaProvider();
    expect(await p.lookup("U12345MH2019PTC123450")).toBeNull();
    await expect(p.lookup("U12345MH2019PTC123453")).rejects.toMatchObject({ kind: "unavailable" });
    expect((await p.lookup("U12345MH2019PTC123451"))?.status).toBe("Struck Off");
    expect((await p.lookup("U12345MH2019PTC123452"))?.companyName).toMatch(/Different/);
    expect(await p.lookup("U12345MH2019PTC123456", { businessName: "Acme Pvt", address: { pincode: "411019" } })).toMatchObject({ companyName: "Acme Pvt", address: { pincode: "411019" } });
    expect((await p.lookup("U12345MH2019PTC123456"))?.companyName).toBe("Mock Industries Private Limited");
    p.setFixture("U12345MH2019PTC123456", null);
    expect(await p.lookup("U12345MH2019PTC123456")).toBeNull();
    p.clearFixtures();
    expect(await p.lookup("U12345MH2019PTC123456")).not.toBeNull();
    expect(mockMcaProvider.name).toBe("mock");
  });
});

describe("Surepass HTTP handling", () => {
  it("udyam: posts to the udyam path under the base url and parses the record", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return json({ success: true, data: { main_details: { name_of_enterprise: "Acme", status: "Cancelled" } } }); }) as unknown as typeof fetch;
    const rec = await surepassUdyamProvider(env(), f).lookup(U);
    expect(url).toBe(`https://vendor.test${SUREPASS_UDYAM_PATH}`);
    expect(rec).toMatchObject({ enterpriseName: "Acme", status: "Cancelled", udyamNumber: U });
  });
  it("mca: posts to the mca path, default base url and timeout from env", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return json({ data: { company_name: "Acme Pvt" } }); }) as unknown as typeof fetch;
    const rec = await surepassMcaProvider({ REGISTRY_PROVIDER_KEY: "tok", REGISTRY_PROVIDER_TIMEOUT_MS: "bogus" } as never, f).lookup(CIN);
    expect(url).toBe(`https://kyc-api.surepass.io${SUREPASS_MCA_PATH}`);
    expect(rec?.companyName).toBe("Acme Pvt");
    await expect(surepassMcaProvider({} as never, f).lookup(CIN)).rejects.toMatchObject({ kind: "auth" });
  });
  it("429 is a rate_limited error that is not retried", async () => {
    let calls = 0;
    const f = (async () => { calls++; return json({}, 429); }) as unknown as typeof fetch;
    await expect(surepassUdyamProvider(env(), f).lookup(U)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toBe(1);
  });
  it("non-JSON is a bad_response; an empty body parses to null (then not-found)", async () => {
    const bad = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(surepassMcaProvider(env(), bad).lookup(CIN)).rejects.toMatchObject({ kind: "bad_response" });
    const empty = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await surepassMcaProvider(env(), empty).lookup(CIN)).toBeNull();
  });
  it("5xx is retried (2 retries) and then surfaces as unavailable", async () => {
    let calls = 0;
    const f = (async () => { calls++; return json({}, 503); }) as unknown as typeof fetch;
    await expect(surepassUdyamProvider(env(), f).lookup(U)).rejects.toMatchObject({ kind: "unavailable" });
    expect(calls).toBe(3);
  }, 15_000);
  it("a transient 5xx followed by success returns the record", async () => {
    let calls = 0;
    const f = (async () => (++calls === 1 ? json({}, 502) : json({ data: { main_details: { name_of_enterprise: "Acme" } } }))) as unknown as typeof fetch;
    expect((await surepassUdyamProvider(env(), f).lookup(U))?.enterpriseName).toBe("Acme");
    expect(calls).toBe(2);
  }, 15_000);
  it("timeouts are mapped to a timeout error and retried", async () => {
    let calls = 0;
    const f = (async () => { calls++; throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    await expect(surepassMcaProvider(env({ REGISTRY_PROVIDER_TIMEOUT_MS: "50" }), f).lookup(CIN)).rejects.toMatchObject({ kind: "timeout" });
    expect(calls).toBe(3);
    calls = 0;
    const g = (async () => { calls++; throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as unknown as typeof fetch;
    await expect(surepassMcaProvider(env(), g).lookup(CIN)).rejects.toMatchObject({ kind: "timeout" });
  }, 15_000);
  it("an unknown failure is wrapped as unavailable without retry; a thrown non-Error too", async () => {
    let calls = 0;
    const f = (async () => { calls++; throw new Error("socket hang up"); }) as unknown as typeof fetch;
    await expect(surepassUdyamProvider(env(), f).lookup(U)).rejects.toThrow(/provider request failed: socket hang up/);
    expect(calls).toBe(1);
    const g = (async () => { throw "weird"; }) as unknown as typeof fetch;
    await expect(surepassUdyamProvider(env(), g).lookup(U)).rejects.toThrow(/provider request failed: weird/);
  });
  it("without an injected fetch the target is validated first (private hosts are refused)", async () => {
    await expect(surepassUdyamProvider(env({ REGISTRY_PROVIDER_BASE_URL: "http://127.0.0.1:9" })).lookup(U)).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("repeated vendor failures open the circuit breaker", async () => {
    // a non-JSON reply is a bad_response: counted by the breaker, not retried (keeps the redis window short)
    const f = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const p = surepassUdyamProvider(env(), f);
    await redis.set("gstn:cb:surepass-udyam:fails", "100");
    await expect(p.lookup(U)).rejects.toMatchObject({ kind: "bad_response" });
    expect(await redis.exists("gstn:cb:surepass-udyam:open")).toBe(1);
    await expect(p.lookup(U)).rejects.toMatchObject({ kind: "circuit_open" });
  });
});

describe("parseSurepassUdyam", () => {
  it("not-found shapes, auth, other statuses", () => {
    expect(parseSurepassUdyam(404, null, U)).toBeNull();
    expect(parseSurepassUdyam(200, { success: false }, U)).toBeNull();
    expect(parseSurepassUdyam(200, { data: { main_details: {} } }, U)).toBeNull();
    expect(parseSurepassUdyam(200, "junk", U)).toBeNull();
    expect(() => parseSurepassUdyam(403, {}, U)).toThrow(/auth/);
    expect(() => parseSurepassUdyam(500, {}, U)).toThrow(/HTTP 500/);
  });
  it("alternate field names, statuses and address shapes", () => {
    const r = parseSurepassUdyam(200, {
      data: {
        enterprise_details: {
          enterprise_name: "Beta Works", udyam_registration_number: "UDYAM-KA-01-0000001", type_of_enterprise: "SMALL", type_of_organization: "Partnership",
          activity: "Services", incorporation_date: "2019-03-05T00:00:00", udyam_status: "Inactive since 2023",
        },
        address: "  12 Main Rd, Bengaluru ",
      },
    }, U);
    expect(r).toMatchObject({
      udyamNumber: "UDYAM-KA-01-0000001", enterpriseName: "Beta Works", enterpriseType: "small", organisationType: "partnership", majorActivity: "Services",
      incorporationDate: "2019-03-05", status: "Inactive", address: { line: "12 Main Rd, Bengaluru" },
    });
    // flat data object, cancelled status, free-form address object assembled from parts, unparseable date
    const flat = parseSurepassUdyam(200, {
      data: { business_name: "Gamma", status: "Cancelled", date_of_incorporation: "not a date", unit_details: { flat: "F1", building: "B2", road: "R3", address_line2: "L2", district: "Pune", pin: "411001" } },
    }, U);
    expect(flat).toMatchObject({ enterpriseName: "Gamma", status: "Cancelled", udyamNumber: U, address: { city: "Pune", pincode: "411001" } });
    expect(flat?.incorporationDate).toBeUndefined();
    expect(flat?.address.line).toBe("F1");
    // address object without a direct line falls back to joined parts
    const parts = parseSurepassUdyam(200, { data: { name: "Delta", official_address: { building: "Tower", area: "MIDC", address_line2: "Phase 2", dist: "Thane", pin_code: "400001" } } }, U);
    expect(parts?.address).toMatchObject({ line: "Tower, Phase 2", city: "Thane", pincode: "400001" });
    // status defaults to Active, empty address when nothing usable
    const none = parseSurepassUdyam(200, { data: { name: "Eps", address: [] } }, U);
    expect(none).toMatchObject({ status: "Active", address: {} });
    const dmy = parseSurepassUdyam(200, { data: { name: "Zeta", incorporation_date: "05-03-2018" } }, U);
    expect(dmy?.incorporationDate).toBe("2018-03-05");
  });
});

describe("parseSurepassMca", () => {
  it("not-found shapes, auth, other statuses", () => {
    expect(parseSurepassMca(422, {}, CIN)).toBeNull();
    expect(parseSurepassMca(200, { success: false }, CIN)).toBeNull();
    expect(() => parseSurepassMca(401, {}, CIN)).toThrow(/auth/);
    expect(() => parseSurepassMca(418, {}, CIN)).toThrow(/HTTP 418/);
  });
  it("maps status variants and alternate field names", () => {
    const mk = (company_status?: string) => parseSurepassMca(200, { data: { business_name: "X", ...(company_status ? { company_status } : {}) } }, CIN)!;
    expect(mk().status).toBe("Active");
    expect(mk("ACTIVE").status).toBe("Active");
    expect(mk("Struck off").status).toBe("Struck Off");
    expect(mk("Under Liquidation").status).toBe("Under Liquidation");
    expect(mk("Amalgamated").status).toBe("Amalgamated");
    expect(mk("Dormant").status).toBe("Inactive");
    const r = parseSurepassMca(200, {
      data: { name: "Y Ltd", cin: "L99999MH2000PLC000001", status: "active", company_class: "Public", date_of_incorporation: "2000-01-31", roc: "RoC-Mumbai", registered_office_address: { city: "Mumbai", state: "MH" } },
    }, CIN);
    expect(r).toMatchObject({ cin: "L99999MH2000PLC000001", classOfCompany: "Public", incorporationDate: "2000-01-31", rocCode: "RoC-Mumbai", address: { city: "Mumbai", state: "MH" } });
    expect(mk("x").cin).toBe(CIN);
  });
});

describe("provider factories", () => {
  it("override wins; mock in dev; production refuses mock; surepass needs a key; unknown refused", () => {
    expect(getUdyamProvider({} as never)).toBe(mockUdyamProvider);
    expect(getMcaProvider({ MCA_PROVIDER: "MOCK" } as never)).toBe(mockMcaProvider);
    expect(() => getMcaProvider({ NODE_ENV: "production" } as never)).toThrow(/MCA_PROVIDER=mock is not allowed in production/);
    expect(() => getMcaProvider({ MCA_PROVIDER: "surepass" } as never)).toThrow(/REGISTRY_PROVIDER_KEY/);
    expect(() => getMcaProvider({ MCA_PROVIDER: "x" } as never)).toThrow(/Unknown MCA_PROVIDER/);
    expect(getMcaProvider({ MCA_PROVIDER: "surepass", REGISTRY_PROVIDER_KEY: "k" } as never).name).toBe("surepass");
    expect(getUdyamProvider({ UDYAM_PROVIDER: "surepass", REGISTRY_PROVIDER_KEY: "k" } as never).name).toBe("surepass");
    const custom = createMockUdyamProvider();
    setUdyamProvider(custom);
    expect(getUdyamProvider({ UDYAM_PROVIDER: "x" } as never)).toBe(custom);
    const customM = createMockMcaProvider();
    setMcaProvider(customM);
    expect(getMcaProvider({} as never)).toBe(customM);
  });
});
