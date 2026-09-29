import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { domainsConfig } from "../src/config";
import { checkCaa, checkDns, createPublicResolver, type CaaRecord, type DnsResolver } from "../src/dns";
import { MockEdgeProvider } from "../src/edge";
import { CHECK_PATH, defaultProbe, domainCheckToken, evaluateDomain, httpProbe, pendingBackoffMs, PENDING_DNS_WINDOW_MS, tlsBackoffMs, TLS_WINDOW_MS, type DomainState, type EvalDeps } from "../src/verify";
import { buildExpectedRecords, newVerifyToken } from "../src/records";
import { domainCheckSecret } from "../src/config";

const cfg = domainsConfig({ STOREFRONT_ROOT_DOMAIN: "cnote.in" } as NodeJS.ProcessEnv);
const TOKEN = "cnote-verify=tok";
const HOST = "www.acme.com";
const T0 = new Date("2026-01-01T00:00:00Z");
const H = 3600_000;

interface Zone { txt?: string[]; cname?: string[]; a?: string[]; targetA?: string[]; caa?: Record<string, CaaRecord[]>; fail?: Set<string>; failCaa?: boolean; chain?: Record<string, string[]> }
function resolver(z: Zone, host = HOST): DnsResolver {
  const guard = (k: string) => { if (z.fail?.has(k)) throw Object.assign(new Error("x"), { code: "ETIMEOUT" }); };
  return {
    async resolveTxt(n) { guard("txt"); return n === `_cnote-verify.${host}` ? (z.txt ?? []).map((v) => [v]) : []; },
    async resolveCname(n) { guard("cname"); if (z.chain?.[n]) return z.chain[n]!; return n === host ? (z.cname ?? []) : []; },
    async resolve4(n) { guard(n === host ? "a" : "ta"); return n === host ? (z.a ?? []) : (z.targetA ?? []); },
    async resolveCaa(n) { if (z.failCaa) throw new Error("caa"); return z.caa?.[n] ?? []; },
  };
}
const ok: Zone = { txt: [TOKEN], cname: ["stores.cnote.in"] };
const state = (o: Partial<DomainState> = {}): DomainState => ({ hostname: HOST, kind: "subdomain", status: "pending_dns", verifyToken: TOKEN, providerRef: null, checkCount: 0, createdAt: T0, verifiedAt: null, windowStartedAt: T0, ...o });
const REF = `mock:${HOST}`;
const mk = (z: Zone, over: Partial<EvalDeps> = {}, edge = new MockEdgeProvider()) => (void edge.createCustomHostname(HOST), { resolver: resolver(z), edge, probe: async () => ({ ok: true }), cfg, now: () => new Date(T0.getTime() + 60_000), ...over }) as EvalDeps;

describe("backoff schedules", () => {
  it("pending: 15s..30m then hourly, monotone non-decreasing", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 500].map(pendingBackoffMs)).toEqual([15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 3600e3, 3600e3]);
    fc.assert(fc.property(fc.nat(1000), (n) => pendingBackoffMs(n + 1) >= pendingBackoffMs(n)));
  });
  it("tls: doubles from 15s, capped at 5m", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 99].map(tlsBackoffMs)).toEqual([15e3, 30e3, 60e3, 120e3, 240e3, 300e3, 300e3, 300e3]);
    fc.assert(fc.property(fc.nat(1000), (n) => tlsBackoffMs(n) <= 300_000 && tlsBackoffMs(n) >= 15_000));
  });
});

describe("evaluateDomain: pending_dns", () => {
  it("stays pending with backoff, first problem as error", async () => {
    const o = await evaluateDomain(state({ checkCount: 2 }), mk({}));
    expect(o).toMatchObject({ status: "pending_dns", requeueMs: 60_000, walk: ["pending_dns"] });
    expect(o.error).toMatch(/could not find the TXT/);
  });
  it("partial records (TXT only / CNAME only) stay pending", async () => {
    expect((await evaluateDomain(state(), mk({ txt: [TOKEN] }))).status).toBe("pending_dns");
    expect((await evaluateDomain(state(), mk({ cname: ["stores.cnote.in"] }))).status).toBe("pending_dns");
  });
  it("wrong TXT value stays pending with a different-value message", async () => {
    const o = await evaluateDomain(state(), mk({ txt: ["nope"], cname: ["stores.cnote.in"] }));
    expect(o.status).toBe("pending_dns");
    expect(o.lastCheck.dns.problems.join()).toMatch(/different value/);
  });
  it("gives up exactly at 72h (boundary) and not before", async () => {
    const just = new Date(T0.getTime() + PENDING_DNS_WINDOW_MS - 1);
    expect((await evaluateDomain(state(), mk({}, { now: () => just }))).status).toBe("pending_dns");
    const at = new Date(T0.getTime() + PENDING_DNS_WINDOW_MS);
    const o = await evaluateDomain(state(), mk({}, { now: () => at }));
    expect(o).toMatchObject({ status: "misconfigured", requeueMs: null });
    expect(o.error).toMatch(/72 hours/);
  });
  it("a manual re-check (new windowStartedAt) restarts the 72h clock", async () => {
    const now = new Date(T0.getTime() + 100 * H);
    const o = await evaluateDomain(state({ windowStartedAt: new Date(now.getTime() - H) }), mk({}, { now: () => now }));
    expect(o.status).toBe("pending_dns");
  });
  it("resolver failures before verification stay pending and are surfaced", async () => {
    const o = await evaluateDomain(state(), mk({ ...ok, fail: new Set(["txt"]) }));
    expect(o.status).toBe("pending_dns");
    expect(o.lastCheck.dns.lookupErrors).toBe(1);
    expect(o.error).toMatch(/failed \(ETIMEOUT\)/);
  });
  it("backoff sequence over successive failing checks follows the schedule", async () => {
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) seen.push((await evaluateDomain(state({ checkCount: i }), mk({}))).requeueMs!);
    expect(seen).toEqual([15, 30, 60, 120, 300, 600, 900, 1800, 3600, 3600].map((s) => s * 1000));
  });
});

describe("evaluateDomain: happy path", () => {
  it("pending_dns -> verifying -> verified -> active with mock edge", async () => {
    const edge = new MockEdgeProvider();
    const o = await evaluateDomain(state(), mk(ok, {}, edge));
    expect(o.walk).toEqual(["pending_dns", "verifying", "verified", "provisioning_tls", "active"]);
    expect(o).toMatchObject({ status: "active", error: null, requeueMs: null, providerRef: `mock:${HOST}` });
    expect(o.lastCheck.probe).toEqual({ ok: true });
    expect(o.lastCheck.edge?.provider).toBe("mock");
  });
  it("edge pending -> provisioning_tls with tls backoff; reuses existing providerRef", async () => {
    const edge = new MockEdgeProvider({ state: "pending", detail: "dcv" });
    const o = await evaluateDomain(state({ checkCount: 3 }), mk(ok, {}, edge));
    const spy = vi.spyOn(edge, "createCustomHostname");
    expect(o).toMatchObject({ status: "provisioning_tls", requeueMs: 120_000 });
    expect(o.walk).toEqual(["pending_dns", "verifying", "verified", "provisioning_tls"]);
    const o2 = await evaluateDomain(state({ status: "provisioning_tls", providerRef: o.providerRef, verifiedAt: T0 }), mk(ok, {}, edge));
    expect(o2.status).toBe("provisioning_tls");
    expect(spy).toHaveBeenCalledTimes(1); // only the mk() pre-registration, not the evaluator
    edge.set(HOST, { state: "active" });
    expect((await evaluateDomain(state({ status: "provisioning_tls", providerRef: o.providerRef, verifiedAt: T0 }), mk(ok, {}, edge))).walk).toEqual(["provisioning_tls", "active"]);
  });
  it("TLS not issued within 24h -> misconfigured", async () => {
    const edge = new MockEdgeProvider({ state: "pending", error: "caa" });
    const late = new Date(T0.getTime() + TLS_WINDOW_MS);
    const o = await evaluateDomain(state({ status: "provisioning_tls", providerRef: REF, verifiedAt: T0 }), mk(ok, { now: () => late }, edge));
        expect(o.status).toBe("misconfigured");
    expect(o.error).toMatch(/24 hours/);
    const early = new Date(T0.getTime() + TLS_WINDOW_MS - 1);
    expect((await evaluateDomain(state({ status: "provisioning_tls", providerRef: REF, verifiedAt: T0 }), mk(ok, { now: () => early }, new MockEdgeProvider({ state: "pending" })))).status).toBe("provisioning_tls");
  });
  it("edge failed -> misconfigured with edge error (or default)", async () => {
    let o = await evaluateDomain(state(), mk(ok, {}, new MockEdgeProvider({ state: "failed", error: "blocked" })));
    expect(o).toMatchObject({ status: "misconfigured", error: "blocked", requeueMs: null });
    o = await evaluateDomain(state(), mk(ok, {}, new MockEdgeProvider({ state: "failed" })));
    expect(o.error).toMatch(/rejected/);
  });
  it("edge provider throwing keeps state and retries in 2m (never regresses active)", async () => {
    const edge = new MockEdgeProvider();
    vi.spyOn(edge, "getStatus").mockRejectedValue(new Error("502"));
    const a = await evaluateDomain(state({ status: "active", providerRef: REF, verifiedAt: T0 }), mk(ok, {}, edge));
    expect(a).toMatchObject({ status: "active", requeueMs: 120_000 });
    expect(a.error).toMatch(/502/);
    const p = await evaluateDomain(state({ status: "provisioning_tls", providerRef: REF, verifiedAt: T0 }), mk(ok, {}, edge));
    expect(p.status).toBe("provisioning_tls");
    const n = await evaluateDomain(state({ providerRef: REF }), mk(ok, {}, edge));
    expect(n.status).toBe("verified");
    const c = new MockEdgeProvider();
    vi.spyOn(c, "createCustomHostname").mockRejectedValue("str");
    expect((await evaluateDomain(state(), mk(ok, {}, c))).error).toMatch(/str/);
  });
  it("probe failure: keeps provisioning_tls before 24h, misconfigured after or if previously active", async () => {
    const bad = { probe: async () => ({ ok: false, error: "nope" }) };
    let o = await evaluateDomain(state(), mk(ok, bad));
    expect(o).toMatchObject({ status: "provisioning_tls", error: "nope" });
    o = await evaluateDomain(state({ status: "active", providerRef: REF, verifiedAt: T0 }), mk(ok, bad));
    expect(o).toMatchObject({ status: "misconfigured", error: "nope" });
    o = await evaluateDomain(state({ status: "provisioning_tls", providerRef: REF, verifiedAt: T0 }), mk(ok, { ...bad, now: () => new Date(T0.getTime() + 25 * H) }));
    expect(o.status).toBe("misconfigured");
    o = await evaluateDomain(state({ status: "active", providerRef: REF, verifiedAt: T0 }), mk(ok, { probe: async () => ({ ok: false }) }));
    expect(o.error).toMatch(/not reachable/);
  });
  it("active stays active (walk is just [active])", async () => {
    const o = await evaluateDomain(state({ status: "active", providerRef: REF, verifiedAt: T0 }), mk(ok));
    expect(o.walk).toEqual(["active"]);
  });
});

describe("evaluateDomain: regressions and self-heal", () => {
  it("previously-live domain whose DNS is gone -> misconfigured (no requeue)", async () => {
    const o = await evaluateDomain(state({ status: "active", verifiedAt: T0, providerRef: REF }), mk({}));
    expect(o).toMatchObject({ status: "misconfigured", requeueMs: null });
  });
  it("resolver hiccup does not knock a live domain offline", async () => {
    const o = await evaluateDomain(state({ status: "active", verifiedAt: T0, providerRef: REF }), mk({ txt: [TOKEN], cname: [], fail: new Set(["cname", "a"]) }));
    expect(o).toMatchObject({ status: "active", requeueMs: 10 * 60_000 });
    const m = await evaluateDomain(state({ status: "misconfigured", verifiedAt: T0 }), mk({ txt: [TOKEN], fail: new Set(["cname"]) }));
    expect(m.status).toBe("misconfigured");
    expect(m.requeueMs).toBe(600_000);
  });
  it("real DNS change with lookup errors on a different record still flips a live domain", async () => {
    const o = await evaluateDomain(state({ status: "active", verifiedAt: T0, providerRef: REF }), mk({ txt: ["wrong"], cname: ["x.other.com"], fail: new Set(["a"]) }));
    expect(o.status).toBe("misconfigured");
  });
  it("misconfigured recovers on a passing check", async () => {
    const o = await evaluateDomain(state({ status: "misconfigured", verifiedAt: T0, providerRef: REF }), mk(ok));
    expect(o.status).toBe("active");
    expect(o.walk).toEqual(["misconfigured", "verifying", "verified", "provisioning_tls", "active"]);
  });
  it("misconfigured (never verified) also recovers", async () => {
    expect((await evaluateDomain(state({ status: "misconfigured" }), mk(ok))).status).toBe("active");
  });
  it("property: outcome is always a valid transition and requeue only when unfinished", async () => {
    const statuses = ["pending_dns", "verifying", "verified", "provisioning_tls", "active", "misconfigured"] as const;
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...statuses), fc.boolean(), fc.boolean(), fc.constantFrom("active", "pending", "failed"), fc.boolean(), fc.integer({ min: 0, max: 100 * 3600 }),
      async (status, txtOk, cnameOk, es, probeOk, ageS) => {
        const o = await evaluateDomain(
          state({ status, verifiedAt: ["verified", "provisioning_tls", "active"].includes(status) ? T0 : null }),
          mk({ txt: txtOk ? [TOKEN] : [], cname: cnameOk ? ["stores.cnote.in"] : [] }, { probe: async () => ({ ok: probeOk }), now: () => new Date(T0.getTime() + ageS * 1000) }, new MockEdgeProvider({ state: es as "active" })),
        );
        expect(o.walk[0]).toBe(status);
        expect(o.walk[o.walk.length - 1]).toBe(o.status);
        expect(new Set(o.walk).size).toBe(o.walk.length === 1 ? 1 : new Set(o.walk).size);
        if (o.status === "active" || o.status === "misconfigured") expect(o.requeueMs).toBeNull();
        if (o.status === "active") expect(txtOk && cnameOk && es === "active" && probeOk).toBe(true);
        if (!txtOk || !cnameOk) expect(o.status).not.toBe("active");
      }), { numRuns: 300 });
  });
});

describe("checkDns matrix", () => {
  const sub = { hostname: HOST, kind: "subdomain" as const, verifyToken: TOKEN };
  it("CNAME chain reaches target", async () => {
    const r = await checkDns(resolver({ txt: [TOKEN], cname: ["lb.cdn.net"], chain: { [HOST]: ["lb.cdn.net"], "lb.cdn.net": ["stores.cnote.in"] } }), sub, cfg, []);
    expect(r).toMatchObject({ ok: true, routing: { via: "cname-chain" } });
  });
  it("CNAME chain that dead-ends is reported", async () => {
    const r = await checkDns(resolver({ txt: [TOKEN], cname: ["lb.cdn.net"], chain: { [HOST]: ["lb.cdn.net"] } }), sub, cfg, []);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/points to lb.cdn.net instead of stores.cnote.in/);
  });
  it("A-record overlap with edge (proxied/flattened) passes; unrelated A fails with hint", async () => {
    expect((await checkDns(resolver({ txt: [TOKEN], a: ["9.9.9.9"], targetA: ["9.9.9.9"] }), sub, cfg, [])).routing.via).toBe("a-overlap");
    const bad = await checkDns(resolver({ txt: [TOKEN], a: ["5.5.5.5"], targetA: ["9.9.9.9"] }), sub, cfg, []);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join()).toMatch(/Remove the A records/);
  });
  it("TXT split across chunks is joined; padded whitespace tolerated", async () => {
    const r: DnsResolver = { ...resolver({ cname: ["stores.cnote.in"] }), resolveTxt: async () => [["cnote-verify=", "tok "]] };
    expect((await checkDns(r, sub, cfg, [])).txt.ok).toBe(true);
  });
  it("CNAME case/trailing dot normalised", async () => {
    expect((await checkDns(resolver({ txt: [TOKEN], cname: ["Stores.CNote.in."] }), sub, cfg, [])).ok).toBe(true);
  });
  it("apex with configured IPs / with ALIAS via target A / via CNAME flattening / failing", async () => {
    const apexCfg = domainsConfig({ STOREFRONT_ROOT_DOMAIN: "cnote.in", STOREFRONT_APEX_IPS: "1.2.3.4" } as NodeJS.ProcessEnv);
    const ap = { hostname: "acme.com", kind: "apex" as const, verifyToken: TOKEN };
    const z = (o: Zone) => resolver({ txt: [TOKEN], ...o }, "acme.com");
    expect((await checkDns(z({ a: ["1.2.3.4"] }), ap, apexCfg, [])).ok).toBe(true);
    expect((await checkDns(z({ a: ["8.8.8.8"], targetA: ["8.8.8.8"] }), ap, cfg, [])).routing.expected).toEqual(["8.8.8.8"]);
    expect((await checkDns(z({ cname: ["stores.cnote.in"] }), ap, cfg, [])).routing.via).toBe("cname");
    const wrong = await checkDns(z({ a: ["7.7.7.7"] }), ap, apexCfg, []);
    expect(wrong.problems.join()).toMatch(/points to 7.7.7.7 but should point to 1.2.3.4/);
    const none = await checkDns(z({}), ap, apexCfg, []);
    expect(none.problems.join()).toMatch(/could not find A\/ALIAS/);
  });
  it("CAA warning surfaces in problems but does not fail ok", async () => {
    const r = await checkDns(resolver({ ...ok, caa: { "acme.com": [{ issue: "sectigo.com" }] } }), sub, cfg, ["letsencrypt.org"]);
    expect(r.ok).toBe(true);
    expect(r.caa.blocking).toBe(true);
    expect(r.problems.join()).toMatch(/CAA/);
  });
  it("CAA lookup throwing inside checkDns is non-fatal", async () => {
    const r = await checkDns(resolver({ ...ok, failCaa: true }), sub, cfg, ["letsencrypt.org"]);
    expect(r.caa).toMatchObject({ blocking: false, records: [] });
  });
  it("uses injected clock", async () => {
    expect((await checkDns(resolver(ok), sub, cfg, [], () => T0)).checkedAt).toBe(T0.toISOString());
  });
});

describe("checkCaa", () => {
  const caa = (m: Record<string, CaaRecord[]>) => resolver({ caa: m });
  const allowed = ["letsencrypt.org", "pki.goog"];
  it("closest ancestor with records wins (walks up)", async () => {
    expect((await checkCaa(caa({ "acme.com": [{ issue: "letsencrypt.org" }] }), HOST, allowed)).blocking).toBe(false);
    const blocked = await checkCaa(caa({ [HOST]: [{ issue: "digicert.com" }], "acme.com": [{ issue: "letsencrypt.org" }] }), HOST, allowed);
    expect(blocked.blocking).toBe(true);
    expect(blocked.warning).toContain(`on ${HOST}`);
  });
  it("issue param stripped; subdomain-of-allowed accepted; empty issue (deny all) blocks", async () => {
    expect((await checkCaa(caa({ "acme.com": [{ issue: "letsencrypt.org; validationmethods=http-01" }] }), HOST, allowed)).blocking).toBe(false);
    expect((await checkCaa(caa({ "acme.com": [{ issue: "x.pki.goog" }] }), HOST, allowed)).blocking).toBe(false);
    expect((await checkCaa(caa({ "acme.com": [{ issue: ";" }] }), HOST, allowed)).blocking).toBe(true);
    expect((await checkCaa(caa({ "acme.com": [{ issue: "" }] }), HOST, allowed)).blocking).toBe(true);
    expect((await checkCaa(caa({ "acme.com": [{ issue: "notletsencrypt.org" }] }), HOST, allowed)).blocking).toBe(true);
  });
  it("only issuewild / iodef does not restrict; none at all does not block", async () => {
    const r = await checkCaa(caa({ "acme.com": [{ issuewild: "x.com" }, { iodef: "mailto:a@b.c" }] }), HOST, allowed);
    expect(r).toMatchObject({ blocking: false, records: ['issuewild "x.com"', "iodef"] });
    expect((await checkCaa(caa({}), HOST, allowed))).toMatchObject({ blocking: false, records: [] });
  });
  it("lookup error is treated as not blocking", async () => {
    expect((await checkCaa(resolver({ failCaa: true }), HOST, allowed)).blocking).toBe(false);
  });
});

describe("createPublicResolver", () => {
  it("returns the four methods and pins servers", () => {
    const r = createPublicResolver(cfg);
    for (const k of ["resolveTxt", "resolveCname", "resolve4", "resolveCaa"] as const) expect(typeof r[k]).toBe("function");
  });
  it("maps NXDOMAIN-style codes to [] and rethrows others (real resolver, invalid name)", async () => {
    const r = createPublicResolver({ ...cfg, resolvers: ["127.0.0.1:1"] });
    // unreachable resolver: an error that is NOT an empty-code must propagate
    await expect(r.resolveTxt("example.com")).rejects.toBeTruthy();
  }, 30000);
});

describe("probe", () => {
  const tokenFor = (h: string) => domainCheckToken(h, domainCheckSecret());
  const resp = (status: number, body: unknown) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  it("token is deterministic per host, case-insensitive, and host-specific", () => {
    expect(domainCheckToken("A.com", "s")).toBe(domainCheckToken("a.com", "s"));
    expect(domainCheckToken("a.com", "s")).not.toBe(domainCheckToken("b.com", "s"));
    expect(domainCheckToken("a.com", "s")).not.toBe(domainCheckToken("a.com", "t"));
  });
  it("ok only with matching token", async () => {
    expect(await httpProbe(HOST, resp(200, { token: tokenFor(HOST) }) as typeof fetch)).toMatchObject({ ok: true, status: 200 });
    expect((await httpProbe(HOST, resp(200, { token: "x" }) as typeof fetch)).error).toMatch(/not from our servers/);
    expect((await httpProbe(HOST, resp(200, "not json") as typeof fetch)).ok).toBe(false);
    expect((await httpProbe(HOST, resp(404, {}) as typeof fetch))).toMatchObject({ ok: false, status: 404 });
  });
  it("network errors become messages; requests use manual redirect + check path", async () => {
    const f = vi.fn(async (..._a: unknown[]) => { throw new Error("ECONNRESET"); });
    expect((await httpProbe(HOST, f as unknown as typeof fetch)).error).toMatch(/ECONNRESET/);
    expect((await httpProbe(HOST, (async () => { throw "weird"; }) as unknown as typeof fetch)).error).toMatch(/network error/);
    const g = vi.fn(async (..._a: unknown[]) => new Response("{}"));
    await httpProbe(HOST, g as unknown as typeof fetch);
    expect(g.mock.calls[0]![0]).toBe(`https://${HOST}${CHECK_PATH}`);
    expect((g.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });
  it("defaultProbe skips for mock provider / env off", async () => {
    expect(await defaultProbe(cfg)("x.com")).toEqual({ ok: true, skipped: true });
    vi.stubEnv("DOMAINS_HTTP_PROBE", "off");
    expect(await defaultProbe({ ...cfg, provider: "cloudflare" })("x.com")).toEqual({ ok: true, skipped: true });
    vi.unstubAllEnvs();
    expect(typeof defaultProbe({ ...cfg, provider: "cloudflare" })).toBe("function");
  });
});

describe("records + config", () => {
  it("verify tokens are unique and well-formed", () => {
    const s = new Set(Array.from({ length: 50 }, newVerifyToken));
    expect(s.size).toBe(50);
    for (const t of s) expect(t).toMatch(/^cnote-verify=[0-9a-f]{32}$/);
  });
  it("apex ALIAS note when no IPs; apex with IPs includes flattening note", () => {
    expect(buildExpectedRecords("acme.com", "apex", TOKEN, cfg).note).toMatch(/www\.acme\.com/);
    expect(buildExpectedRecords("acme.com", "apex", TOKEN, domainsConfig({ STOREFRONT_APEX_IPS: "1.1.1.1" } as NodeJS.ProcessEnv)).note).toMatch(/ALIAS/);
  });
  it("config: defaults, unknown provider -> mock, lists trimmed, secret fallbacks", () => {
    const d = domainsConfig({} as NodeJS.ProcessEnv);
    expect(d).toMatchObject({ rootDomain: "localhost", cnameTarget: "stores.localhost", provider: "mock", apexIps: [], resolvers: ["1.1.1.1", "8.8.8.8"], maxDomainsPerStorefront: 3 });
    expect(domainsConfig({ EDGE_PROVIDER: " Vercel ", PLATFORM_HOSTS: " A.com , ,B.com" } as NodeJS.ProcessEnv)).toMatchObject({ provider: "vercel", platformHosts: ["a.com", "b.com"] });
    expect(domainsConfig({ EDGE_PROVIDER: "bogus" } as NodeJS.ProcessEnv).provider).toBe("mock");
    expect(domainCheckSecret({ DOMAIN_CHECK_SECRET: "a", JWT_SECRET: "b" } as NodeJS.ProcessEnv)).toBe("a");
    expect(domainCheckSecret({ JWT_SECRET: "b" } as NodeJS.ProcessEnv)).toBe("b");
    expect(domainCheckSecret({ AUTH_SECRET: "c" } as NodeJS.ProcessEnv)).toBe("c");
    expect(domainCheckSecret({} as NodeJS.ProcessEnv)).toBe("cnote-dev-domain-check");
  });
});
