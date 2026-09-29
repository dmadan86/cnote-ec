import { describe, expect, it } from "vitest";
import { domainsConfig } from "../src/config";
import { checkCaa, checkDns, type CaaRecord, type DnsResolver } from "../src/dns";
import { MockEdgeProvider } from "../src/edge";
import { CloudflareEdgeProvider } from "../src/edge/cloudflare";
import { buildExpectedRecords } from "../src/records";
import { evaluateDomain, pendingBackoffMs, type DomainState, type EvalDeps } from "../src/verify";

const cfg = domainsConfig({ STOREFRONT_ROOT_DOMAIN: "cnote.in", STOREFRONT_APEX_IPS: "203.0.113.10,203.0.113.11" } as NodeJS.ProcessEnv);
const TOKEN = "cnote-verify=abc123";

interface Zone {
  txt?: Record<string, string[]>;
  cname?: Record<string, string>;
  a?: Record<string, string[]>;
  caa?: Record<string, CaaRecord[]>;
  fail?: Set<string>;
}
function fakeResolver(z: Zone): DnsResolver {
  const guard = (n: string) => {
    if (z.fail?.has(n)) throw Object.assign(new Error("servfail"), { code: "ESERVFAIL" });
  };
  return {
    async resolveTxt(n) { guard(n); return (z.txt?.[n] ?? []).map((v) => [v]); },
    async resolveCname(n) { guard(n); return z.cname?.[n] ? [z.cname[n]!] : []; },
    async resolve4(n) { guard(n); return z.a?.[n] ?? []; },
    async resolveCaa(n) { return z.caa?.[n] ?? []; },
  };
}
const good = (host = "www.acme.com"): Zone => ({ txt: { [`_cnote-verify.${host}`]: [TOKEN] }, cname: { [host]: "stores.cnote.in" } });
const base: DomainState = {
  hostname: "www.acme.com", kind: "subdomain", status: "pending_dns", verifyToken: TOKEN, providerRef: null, checkCount: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"), verifiedAt: null, windowStartedAt: new Date("2026-01-01T00:00:00Z"),
};
const at = (iso: string) => () => new Date(iso);
function deps(zone: Zone, over: Partial<EvalDeps> = {}): EvalDeps & { edge: MockEdgeProvider } {
  return { resolver: fakeResolver(zone), edge: new MockEdgeProvider(), probe: async () => ({ ok: true }), cfg, now: at("2026-01-01T00:10:00Z"), ...over } as EvalDeps & { edge: MockEdgeProvider };
}

describe("expected records", () => {
  it("subdomain: CNAME + TXT", () => {
    const r = buildExpectedRecords("www.acme.com", "subdomain", TOKEN, cfg);
    expect(r.records).toEqual([
      { type: "CNAME", name: "www.acme.com", value: "stores.cnote.in", purpose: "routing" },
      { type: "TXT", name: "_cnote-verify.www.acme.com", value: TOKEN, purpose: "ownership" },
    ]);
  });
  it("apex: A records when configured, ALIAS otherwise", () => {
    expect(buildExpectedRecords("acme.com", "apex", TOKEN, cfg).records.filter((r) => r.type === "A").map((r) => r.value)).toEqual(["203.0.113.10", "203.0.113.11"]);
    const noIps = domainsConfig({ STOREFRONT_ROOT_DOMAIN: "cnote.in" } as NodeJS.ProcessEnv);
    expect(buildExpectedRecords("acme.com", "apex", TOKEN, noIps).records[0]).toMatchObject({ type: "ALIAS", value: "stores.cnote.in" });
  });
});

describe("checkDns", () => {
  it("passes with TXT + CNAME", async () => {
    const r = await checkDns(fakeResolver(good()), base, cfg, ["letsencrypt.org"]);
    expect(r.ok).toBe(true);
    expect(r.routing.via).toBe("cname");
  });
  it("follows CNAME chains", async () => {
    const z = good();
    z.cname = { "www.acme.com": "lb.acme-cdn.net", "lb.acme-cdn.net": "stores.cnote.in" };
    expect((await checkDns(fakeResolver(z), base, cfg, [])).routing.via).toBe("cname-chain");
  });
  it("accepts proxied/flattened A overlap with the edge", async () => {
    const z: Zone = { txt: good().txt, a: { "www.acme.com": ["198.51.100.7"], "stores.cnote.in": ["198.51.100.7"] } };
    expect((await checkDns(fakeResolver(z), base, cfg, [])).routing.via).toBe("a-overlap");
  });
  it("reports what it saw when things are wrong", async () => {
    const z: Zone = { txt: { "_cnote-verify.www.acme.com": ["wrong"] }, cname: { "www.acme.com": "other.example.net" } };
    const r = await checkDns(fakeResolver(z), base, cfg, []);
    expect(r.ok).toBe(false);
    expect(r.txt.observed).toEqual(["wrong"]);
    expect(r.routing.observedCname).toEqual(["other.example.net"]);
    expect(r.problems.join(" ")).toMatch(/different value/);
    expect(r.problems.join(" ")).toMatch(/instead of stores\.cnote\.in/);
  });
  it("explains A records where a CNAME is needed", async () => {
    const r = await checkDns(fakeResolver({ txt: good().txt, a: { "www.acme.com": ["1.2.3.4"] } }), base, cfg, []);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/Remove the A records/);
  });
  it("apex matches configured A records", async () => {
    const d: DomainState = { ...base, hostname: "acme.com", kind: "apex" };
    const ok = await checkDns(fakeResolver({ txt: { "_cnote-verify.acme.com": [TOKEN] }, a: { "acme.com": ["203.0.113.10"] } }), d, cfg, []);
    expect(ok.ok).toBe(true);
    const bad = await checkDns(fakeResolver({ txt: { "_cnote-verify.acme.com": [TOKEN] }, a: { "acme.com": ["9.9.9.9"] } }), d, cfg, []);
    expect(bad.ok).toBe(false);
  });
  it("counts resolver failures separately from missing records", async () => {
    const r = await checkDns(fakeResolver({ fail: new Set(["www.acme.com"]) }), base, cfg, []);
    expect(r.lookupErrors).toBeGreaterThan(0);
  });
});

describe("checkCaa", () => {
  const r = (caa: Record<string, CaaRecord[]>) => fakeResolver({ caa });
  it("no CAA means no restriction", async () => expect((await checkCaa(r({}), "www.acme.com", ["letsencrypt.org"])).blocking).toBe(false));
  it("allows a listed CA (closest name wins)", async () => {
    const c = await checkCaa(r({ "acme.com": [{ issue: "letsencrypt.org" }] }), "www.acme.com", ["letsencrypt.org"]);
    expect(c.blocking).toBe(false);
  });
  it("warns when only other CAs are allowed", async () => {
    const c = await checkCaa(r({ "acme.com": [{ issue: "digicert.com" }] }), "www.acme.com", ["letsencrypt.org"]);
    expect(c.blocking).toBe(true);
    expect(c.warning).toMatch(/letsencrypt\.org/);
  });
  it('treats issue ";" (deny all) as blocking', async () => {
    expect((await checkCaa(r({ "www.acme.com": [{ issue: ";" }] }), "www.acme.com", ["letsencrypt.org"])).blocking).toBe(true);
  });
});

describe("state machine", () => {
  it("pending_dns stays pending with backoff while DNS is missing", async () => {
    const o = await evaluateDomain(base, deps({}));
    expect(o.status).toBe("pending_dns");
    expect(o.requeueMs).toBe(pendingBackoffMs(0));
    expect(o.walk).toEqual(["pending_dns"]);
    expect(o.lastCheck.dns.txt.ok).toBe(false);
  });
  it("backs off progressively and caps at hourly", () => {
    expect(pendingBackoffMs(0)).toBeLessThan(pendingBackoffMs(3));
    expect(pendingBackoffMs(99)).toBe(3600_000);
  });
  it("gives up after 72h of missing DNS", async () => {
    const o = await evaluateDomain(base, deps({}, { now: at("2026-01-04T00:00:01Z") }));
    expect(o.status).toBe("misconfigured");
    expect(o.requeueMs).toBeNull();
    expect(o.error).toMatch(/72 hours/);
  });
  it("walks pending_dns -> verifying -> verified -> provisioning_tls -> active with the mock edge", async () => {
    const d = deps(good());
    const o = await evaluateDomain(base, d);
    expect(o.walk).toEqual(["pending_dns", "verifying", "verified", "provisioning_tls", "active"]);
    expect(o.status).toBe("active");
    expect(o.providerRef).toBe("mock:www.acme.com");
    expect(o.requeueMs).toBeNull();
  });
  it("stays in provisioning_tls while the edge is pending, then activates", async () => {
    const edge = new MockEdgeProvider({ state: "pending", detail: "pending_validation" });
    const first = await evaluateDomain(base, deps(good(), { edge }));
    expect(first.status).toBe("provisioning_tls");
    expect(first.requeueMs).toBeGreaterThan(0);
    edge.set("www.acme.com", { state: "active" });
    const second = await evaluateDomain({ ...base, status: "provisioning_tls", providerRef: first.providerRef, verifiedAt: new Date("2026-01-01T00:05:00Z"), checkCount: 1 }, deps(good(), { edge }));
    expect(second.walk).toEqual(["provisioning_tls", "active"]);
  });
  it("does not go active until the reachability probe passes", async () => {
    const o = await evaluateDomain(base, deps(good(), { probe: async () => ({ ok: false, error: "nope" }) }));
    expect(o.status).toBe("provisioning_tls");
    expect(o.error).toBe("nope");
    expect(o.requeueMs).not.toBeNull();
  });
  it("gives up on TLS after 24h", async () => {
    const edge = new MockEdgeProvider({ state: "pending" });
    const o = await evaluateDomain({ ...base, status: "provisioning_tls", providerRef: "mock:www.acme.com", verifiedAt: new Date("2026-01-01T00:00:00Z") }, deps(good(), { edge, now: at("2026-01-02T00:00:01Z") }));
    expect(o.status).toBe("misconfigured");
  });
  it("edge failure -> misconfigured", async () => {
    const edge = new MockEdgeProvider({ state: "failed", error: "CAA blocks issuance" });
    const o = await evaluateDomain(base, deps(good(), { edge }));
    expect(o.status).toBe("misconfigured");
    expect(o.error).toBe("CAA blocks issuance");
  });
  it("active domain whose DNS breaks -> misconfigured (single transition)", async () => {
    const live: DomainState = { ...base, status: "active", providerRef: "mock:www.acme.com", verifiedAt: new Date("2026-01-01T00:00:00Z") };
    const o = await evaluateDomain(live, deps({ txt: good().txt, cname: { "www.acme.com": "elsewhere.net" } }));
    expect(o.walk).toEqual(["active", "misconfigured"]);
    expect(o.requeueMs).toBeNull();
  });
  it("active domain survives a resolver outage", async () => {
    const live: DomainState = { ...base, status: "active", providerRef: "mock:www.acme.com", verifiedAt: new Date("2026-01-01T00:00:00Z") };
    const o = await evaluateDomain(live, deps({ fail: new Set(["_cnote-verify.www.acme.com", "www.acme.com"]) }));
    expect(o.status).toBe("active");
    expect(o.requeueMs).not.toBeNull();
  });
  it("active domain that stays healthy emits no transitions", async () => {
    const edge = new MockEdgeProvider();
    await edge.createCustomHostname("www.acme.com");
    const live: DomainState = { ...base, status: "active", providerRef: "mock:www.acme.com", verifiedAt: new Date("2026-01-01T00:00:00Z") };
    const o = await evaluateDomain(live, deps(good(), { edge }));
    expect(o.walk).toEqual(["active"]);
  });
  it("misconfigured (previously verified) recovers when DNS is fixed", async () => {
    const edge = new MockEdgeProvider();
    const o = await evaluateDomain({ ...base, status: "misconfigured", providerRef: null, verifiedAt: new Date("2026-01-01T00:00:00Z") }, deps(good(), { edge }));
    expect(o.status).toBe("active");
  });
  it("transient provider errors keep the domain at verified and retry", async () => {
    const edge = new MockEdgeProvider();
    edge.createCustomHostname = async () => { throw new Error("boom"); };
    const o = await evaluateDomain(base, deps(good(), { edge }));
    expect(o.status).toBe("verified");
    expect(o.error).toMatch(/boom/);
    expect(o.requeueMs).toBe(120_000);
  });
});

describe("cloudflare adapter status mapping", () => {
  const map = CloudflareEdgeProvider.toStatus;
  it("active only when hostname and ssl are active", () => {
    expect(map({ id: "1", hostname: "h", status: "active", ssl: { status: "active" } }).state).toBe("active");
    expect(map({ id: "1", hostname: "h", status: "active", ssl: { status: "pending_validation" } }).state).toBe("pending");
    expect(map({ id: "1", hostname: "h", status: "pending", ssl: { status: "initializing" } }).state).toBe("pending");
    expect(map({ id: "1", hostname: "h", status: "blocked" }).state).toBe("failed");
  });
  it("calls the API and adopts an existing hostname on duplicate", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.replace(/^.*custom_hostnames/, "")}`);
      if (init?.method === "POST") return new Response(JSON.stringify({ success: false, errors: [{ code: 1406, message: "dup" }], result: null }));
      return new Response(JSON.stringify({ success: true, result: [{ id: "ch1", hostname: "h", status: "pending", ssl: { status: "pending_validation" } }] }));
    };
    const p = new CloudflareEdgeProvider("tok", "zone", fetchImpl);
    const r = await p.createCustomHostname("www.acme.com");
    expect(r.ref).toBe("ch1");
    expect(calls).toEqual(["POST ", "GET ?hostname=www.acme.com"]);
  });
});
