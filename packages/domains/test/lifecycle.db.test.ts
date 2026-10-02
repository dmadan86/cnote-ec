import { DomainError, redis, setJobQueue, type JobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { domainsConfig } from "../src/config";
import type { CaaRecord, DnsResolver } from "../src/dns";
import { MockEdgeProvider, setEdgeProvider } from "../src/edge";
import {
  addDomain, adminDomainCounts, adminListDomains, domainCheckResponse, domainSetupInfo, forceRecheck, listDomains, processDomainCheck,
  recheckLiveDomains, removeDomain, removeDomainById, requestRecheck, setPrimary, startVerification, sweepStalledDomains, toView,
} from "../src/lifecycle";
import { customDomainOrigin, resolveHost, storefrontCanonical } from "../src/resolve";
import { worker } from "../src/worker";
import { domainCheckToken } from "../src/verify";

const run = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
const cfg = domainsConfig();
interface Enq { topic: string; payload: { domainId: string; gen?: number }; opts: { delayMs?: number; dedupeKey?: string } }
let enq: Enq[] = [];
const queue = { enqueue: async (topic: string, payload: Enq["payload"], opts: Enq["opts"] = {}) => { enq.push({ topic, payload, opts }); return "id"; } } as unknown as JobQueue;

const bizIds: string[] = [];
const sfIds: string[] = [];
async function mkSeller(tag: string, status: "draft" | "live" = "live") {
  const b = await prisma.business.create({ data: { name: `dom-${tag}-${run}` } });
  const slug = `dm-${tag}-${run}`.slice(0, 38);
  const sf = await prisma.storefront.create({ data: { sellerBusinessId: b.id, slug, status } });
  bizIds.push(b.id);
  sfIds.push(sf.id);
  return { biz: b.id, sf: sf.id, slug };
}
const host = (n: string) => `${n}-${run}.acme-shop.com`;
function resolverFor(h: string, token: string, opts: { txt?: boolean; cname?: boolean; caa?: CaaRecord[] } = {}): DnsResolver {
  return {
    async resolveTxt(n) { return opts.txt === false || n !== `_cnote-verify.${h}` ? [] : [[token]]; },
    async resolveCname(n) { return opts.cname === false || n !== h ? [] : [cfg.cnameTarget]; },
    async resolve4() { return []; },
    async resolveCaa() { return opts.caa ?? []; },
  };
}
async function tokenOf(id: string) { return (await prisma.storefrontDomain.findUniqueOrThrow({ where: { id } })).verifyToken; }
async function verifyNow(id: string, h: string, edge: MockEdgeProvider, o: { txt?: boolean; cname?: boolean; now?: Date; gen?: number; probe?: boolean } = {}) {
  return processDomainCheck(id, o.gen, {
    resolver: resolverFor(h, await tokenOf(id), o), edge, probe: async () => ({ ok: o.probe ?? true }), now: o.now ? () => o.now! : undefined,
  });
}
const rowOf = (id: string) => prisma.storefrontDomain.findUniqueOrThrow({ where: { id } });
const eventsOf = async (id: string) => (await prisma.domainEvent.findMany({ where: { aggregateId: id, type: "StorefrontDomainStatusChanged" }, orderBy: { occurredAt: "asc" } })).map((e) => (e.payload as { from: string; to: string }));

beforeAll(() => { setJobQueue(queue); });
beforeEach(() => { enq = []; });
afterAll(async () => {
  setJobQueue(undefined);
  setEdgeProvider(undefined);
  const doms = await prisma.storefrontDomain.findMany({ where: { storefrontId: { in: sfIds } }, select: { id: true, hostname: true } });
  const ids = doms.map((d) => d.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.storefrontDomain.deleteMany({ where: { storefrontId: { in: sfIds } } });
  await prisma.storefront.deleteMany({ where: { id: { in: sfIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  for (const id of ids) await redis.del(`dv:gen:${id}`, `dv:lock:${id}`, `domains:recheck:${id}`);
});

afterEach(() => vi.useRealTimers());

describe("addDomain", () => {
  it("requires a storefront", async () => {
    const b = await prisma.business.create({ data: { name: `nosf-${run}` } });
    bizIds.push(b.id);
    await expect(addDomain(b.id, host("x"))).rejects.toMatchObject({ code: "not_found" });
    expect(await listDomains(b.id)).toEqual([]);
    expect(await domainSetupInfo(b.id)).toMatchObject({ slug: null, platformHost: null, cnameTarget: cfg.cnameTarget, max: 3 });
  });
  it("creates pending_dns row, records, event, and starts verification", async () => {
    const s = await mkSeller("add");
    const h = `WWW.${host("add")}`;
    const v = await addDomain(s.biz, h);
    expect(v).toMatchObject({ hostname: h.toLowerCase(), kind: "subdomain", status: "pending_dns", isPrimary: false, url: null, checkCount: 0, verifiedAt: null });
    expect(v.records.map((r) => r.type)).toEqual(["CNAME", "TXT"]);
    expect(v.records[1]!.value).toBe(await tokenOf(v.id));
    expect(await eventsOf(v.id)).toEqual([{ domainId: v.id, storefrontId: s.sf, sellerBusinessId: s.biz, hostname: v.hostname, from: "none", to: "pending_dns", error: null }].map((e) => ({ ...e })));
    expect(enq).toHaveLength(1);
    expect(enq[0]).toMatchObject({ topic: "domain.verify", payload: { domainId: v.id, gen: 1 } });
    expect((await listDomains(s.biz)).map((d) => d.id)).toEqual([v.id]);
    expect(await domainSetupInfo(s.biz)).toMatchObject({ slug: s.slug, platformHost: `${s.slug}.${cfg.rootDomain}` });
  });
  it("rejects invalid hostnames, duplicates (across sellers) and the per-storefront cap", async () => {
    const s = await mkSeller("cap");
    const other = await mkSeller("cap2");
    await expect(addDomain(s.biz, "https://x.com")).rejects.toMatchObject({ code: "validation" });
    const a = await addDomain(s.biz, host("a"));
    await expect(addDomain(other.biz, a.hostname)).rejects.toMatchObject({ code: "conflict" });
    await expect(addDomain(s.biz, a.hostname)).rejects.toMatchObject({ code: "conflict" });
    await addDomain(s.biz, host("b"));
    await addDomain(s.biz, host("c"));
    await expect(addDomain(s.biz, host("d"))).rejects.toThrow(/up to 3/);
    expect(await prisma.storefrontDomain.count({ where: { storefrontId: s.sf } })).toBe(3);
  });
});

describe("processDomainCheck: full lifecycle", () => {
  it("pending -> active, primary assignment, events per hop, cache invalidation", async () => {
    const s = await mkSeller("life");
    const { id, hostname: h } = await addDomain(s.biz, host("life"));
    expect(await resolveHost(h)).toBeNull(); // negative-cached while pending
    const edge = new MockEdgeProvider();

    enq = [];
    let r = await verifyNow(id, h, edge, { txt: false });
    expect(r).toEqual({ status: "pending_dns", changed: false });
    let row = await rowOf(id);
    expect(row).toMatchObject({ status: "pending_dns", checkCount: 1, verifiedAt: null, isPrimary: false });
    expect(row.lastError).toMatch(/TXT/);
    expect(enq).toHaveLength(1);
    expect(enq[0]!.opts.delayMs).toBe(15_000);

    enq = [];
    r = await verifyNow(id, h, edge);
    expect(r).toEqual({ status: "active", changed: true });
    row = await rowOf(id);
    expect(row).toMatchObject({ status: "active", isPrimary: true, providerRef: `mock:${h}`, checkCount: 2, lastError: null });
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(row.activatedAt).toBeInstanceOf(Date);
    expect(enq).toHaveLength(0); // chain finished
    const ev = await eventsOf(id);
    // hops of one step are written in one transaction (same timestamp), so compare as a set
    expect(ev.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["none>pending_dns", "pending_dns>verifying", "verifying>verified", "verified>provisioning_tls", "provisioning_tls>active"].sort());
    expect(toView(row).url).toBe(`https://${h}`);
    // host cache was invalidated on activation -> resolves right away
    expect(await resolveHost(h)).toEqual({ kind: "custom", storefrontSlug: s.slug, canonicalHost: h });
    expect(await resolveHost(`${h}:443`)).toMatchObject({ kind: "custom" });
    expect(await storefrontCanonical(s.slug)).toBe(`https://${h}`);
    expect(await customDomainOrigin(s.slug)).toBe(`https://${h}`);
  });

  it("customDomainOrigin is null without an active custom domain (the marketplace path stays canonical)", async () => {
    const s = await mkSeller("nocustom");
    expect(await customDomainOrigin(s.slug)).toBeNull();
    await addDomain(s.biz, host("pending")); // pending DNS is not active
    expect(await customDomainOrigin(s.slug)).toBeNull();
    expect(await customDomainOrigin(`missing-${run}`)).toBeNull();
  });

  it("second active domain is not primary; setPrimary switches canonical; only active domains qualify", async () => {
    const s = await mkSeller("prim");
    const a = await addDomain(s.biz, host("p1"));
    const b = await addDomain(s.biz, host("p2"));
    const c = await addDomain(s.biz, host("p3"));
    const edge = new MockEdgeProvider();
    await verifyNow(a.id, a.hostname, edge);
    await verifyNow(b.id, b.hostname, edge);
    expect((await rowOf(a.id)).isPrimary).toBe(true);
    expect((await rowOf(b.id)).isPrimary).toBe(false);
    await expect(setPrimary(s.biz, c.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(setPrimary("00000000-0000-0000-0000-000000000000", b.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await resolveHost(b.hostname)).toMatchObject({ canonicalHost: a.hostname }); // non-primary points at the primary
    await setPrimary(s.biz, b.id);
    expect((await rowOf(a.id)).isPrimary).toBe(false);
    expect((await rowOf(b.id)).isPrimary).toBe(true);
    expect(await prisma.storefrontDomain.count({ where: { storefrontId: s.sf, isPrimary: true } })).toBe(1);
    expect(await resolveHost(a.hostname)).toMatchObject({ canonicalHost: b.hostname });
    expect(await storefrontCanonical(s.slug)).toBe(`https://${b.hostname}`);
  });

  it("active domain whose DNS disappears -> misconfigured, loses primary, next active is promoted, host stops resolving", async () => {
    const s = await mkSeller("demote");
    const a = await addDomain(s.biz, host("d1"));
    const b = await addDomain(s.biz, host("d2"));
    const edge = new MockEdgeProvider();
    await verifyNow(a.id, a.hostname, edge);
    await verifyNow(b.id, b.hostname, edge);
    expect(await resolveHost(a.hostname)).not.toBeNull();
    const r = await verifyNow(a.id, a.hostname, edge, { cname: false });
    expect(r).toEqual({ status: "misconfigured", changed: true });
    expect(await rowOf(a.id)).toMatchObject({ status: "misconfigured", isPrimary: false });
    expect((await rowOf(b.id)).isPrimary).toBe(true);
    expect(await resolveHost(a.hostname)).toBeNull();
    // self-heals
    expect((await verifyNow(a.id, a.hostname, edge))).toEqual({ status: "active", changed: true });
    expect((await rowOf(a.id)).isPrimary).toBe(false); // b remains the primary
  });

  it("72h without DNS -> misconfigured and chain stops (fake time)", async () => {
    const s = await mkSeller("giveup");
    const { id, hostname: h } = await addDomain(s.biz, host("gu"));
    const created = (await rowOf(id)).createdAt;
    const edge = new MockEdgeProvider();
    enq = [];
    let r = await verifyNow(id, h, edge, { txt: false, cname: false, now: new Date(created.getTime() + 71 * 3600_000) });
    expect(r?.status).toBe("pending_dns");
    expect(enq).toHaveLength(1);
    enq = [];
    r = await verifyNow(id, h, edge, { txt: false, cname: false, now: new Date(created.getTime() + 72 * 3600_000) });
    expect(r).toEqual({ status: "misconfigured", changed: true });
    expect(enq).toHaveLength(0);
    expect((await rowOf(id)).lastError).toMatch(/72 hours/);
    // manual recheck restarts the window
    await forceRecheck(id);
    expect(((await rowOf(id)).lastCheck as { windowStartedAt: string }).windowStartedAt).not.toBe(created.toISOString());
    r = await verifyNow(id, h, edge, { txt: false, cname: false, now: new Date(Date.now() + 60_000) });
    expect(r?.status).toBe("pending_dns");
  });

  it("edge pending keeps provisioning_tls + schedules tls backoff; later becomes active", async () => {
    const s = await mkSeller("tls");
    const { id, hostname: h } = await addDomain(s.biz, host("tls"));
    const edge = new MockEdgeProvider({ state: "pending", detail: "dcv" });
    enq = [];
    expect(await verifyNow(id, h, edge)).toEqual({ status: "provisioning_tls", changed: true });
    expect(enq[0]!.opts.delayMs).toBe(15_000);
    expect((await rowOf(id)).verifiedAt).not.toBeNull();
    expect(await resolveHost(h)).toBeNull();
    edge.set(h, { state: "active" });
    expect(await verifyNow(id, h, edge)).toEqual({ status: "active", changed: true });
    const ev = await eventsOf(id);
    expect(ev.map((e) => `${e.from}>${e.to}`)).toContain("provisioning_tls>active");
  });

  it("guards: superseded generation, held lock, missing row", async () => {
    const s = await mkSeller("guard");
    const { id, hostname: h } = await addDomain(s.biz, host("gd"));
    const edge = new MockEdgeProvider();
    await redis.set(`dv:gen:${id}`, "5");
    expect(await verifyNow(id, h, edge, { gen: 4 })).toBeNull();
    expect((await rowOf(id)).checkCount).toBe(0);
    await redis.set(`dv:lock:${id}`, "1", "EX", 60);
    expect(await verifyNow(id, h, edge, { gen: 5 })).toBeNull();
    await redis.del(`dv:lock:${id}`);
    expect(await verifyNow(id, h, edge, { gen: 5, txt: false })).toMatchObject({ status: "pending_dns" });
    expect(await redis.get(`dv:lock:${id}`)).toBeNull(); // lock released
    expect(await processDomainCheck("00000000-0000-0000-0000-000000000000", undefined, { lock: false })).toBeNull();
  });

  it("concurrent checks: only one runs the step (lock)", async () => {
    const s = await mkSeller("conc");
    const { id, hostname: h } = await addDomain(s.biz, host("cc"));
    const edge = new MockEdgeProvider();
    const res = await Promise.all([verifyNow(id, h, edge, { txt: false }), verifyNow(id, h, edge, { txt: false }), verifyNow(id, h, edge, { txt: false })]);
    expect(res.filter(Boolean)).toHaveLength(1);
    expect((await rowOf(id)).checkCount).toBe(1);
  });
});

describe("verification scheduling", () => {
  it("startVerification bumps the generation so older chains are superseded", async () => {
    const s = await mkSeller("gen");
    const { id, hostname: h } = await addDomain(s.biz, host("gen"));
    await startVerification(id, 5000);
    await startVerification(id);
    expect(enq.map((e) => e.payload.gen)).toEqual([1, 2, 3]); // 1 from addDomain
    expect(enq[1]!.opts.delayMs).toBe(5000);
    expect(enq[2]!.opts.delayMs).toBeUndefined();
    expect(await verifyNow(id, h, new MockEdgeProvider(), { gen: 1, txt: false })).toBeNull();
  });
  it("requestRecheck is owner-only and rate-limited to 5 per window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    const s = await mkSeller("rl");
    const other = await mkSeller("rl2");
    const { id } = await addDomain(s.biz, host("rl"));
    await expect(requestRecheck(other.biz, id)).rejects.toMatchObject({ code: "not_found" });
    for (let i = 0; i < 5; i++) await requestRecheck(s.biz, id);
    await expect(requestRecheck(s.biz, id)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(forceRecheck("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(DomainError);
  });
});

describe("removeDomain", () => {
  it("is owner-only; deletes edge hostname; promotes next active primary; invalidates cache", async () => {
    const s = await mkSeller("rm");
    const other = await mkSeller("rm2");
    const a = await addDomain(s.biz, host("r1"));
    const b = await addDomain(s.biz, host("r2"));
    const edge = new MockEdgeProvider();
    setEdgeProvider(edge);
    await verifyNow(a.id, a.hostname, edge);
    await verifyNow(b.id, b.hostname, edge);
    expect(await resolveHost(a.hostname)).not.toBeNull();
    await expect(removeDomain(other.biz, a.id)).rejects.toMatchObject({ code: "not_found" });
    await removeDomain(s.biz, a.id);
    expect(await prisma.storefrontDomain.findUnique({ where: { id: a.id } })).toBeNull();
    expect(edge.hosts.has(a.hostname)).toBe(false);
    expect((await rowOf(b.id)).isPrimary).toBe(true);
    expect(await resolveHost(a.hostname)).toBeNull();
    expect((await eventsOf(a.id)).find((e) => e.to === "removed")).toMatchObject({ from: "active" });
    await expect(removeDomainById(a.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await storefrontCanonical(s.slug)).toBe(`https://${b.hostname}`);
  });
  it("edge delete failure is best-effort", async () => {
    const s = await mkSeller("rmf");
    const a = await addDomain(s.biz, host("rf"));
    const edge = new MockEdgeProvider();
    await verifyNow(a.id, a.hostname, edge);
    const bad = new MockEdgeProvider();
    vi.spyOn(bad, "delete").mockRejectedValue(new Error("edge down"));
    setEdgeProvider(bad);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await removeDomainById(a.id);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(await prisma.storefrontDomain.findUnique({ where: { id: a.id } })).toBeNull();
    setEdgeProvider(undefined);
  });
  it("removing a non-primary or never-active domain leaves primary alone", async () => {
    const s = await mkSeller("rmn");
    const a = await addDomain(s.biz, host("n1"));
    const b = await addDomain(s.biz, host("n2"));
    await verifyNow(a.id, a.hostname, new MockEdgeProvider());
    await removeDomainById(b.id);
    expect((await rowOf(a.id)).isPrimary).toBe(true);
  });
});

describe("sweeps", () => {
  it("recheckLiveDomains: once per window, queues active + verified-misconfigured, purges stale unverified claims", async () => {
    const s = await mkSeller("sweep");
    const act = await addDomain(s.biz, host("s1"));
    await verifyNow(act.id, act.hostname, new MockEdgeProvider());
    const stale = await addDomain(s.biz, host("s2"));
    await prisma.storefrontDomain.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 3600_000) } });
    const fresh = await addDomain(s.biz, host("s3"));
    await redis.del("dv:daily");
    enq = [];
    const n = await recheckLiveDomains();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(enq.some((e) => e.payload.domainId === act.id)).toBe(true);
    expect(await prisma.storefrontDomain.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.storefrontDomain.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await recheckLiveDomains()).toBe(0); // guarded
    await redis.del("dv:daily");
  });
  it("sweepStalledDomains: restarts only old, unchecked-or-stale in-progress chains", async () => {
    const s = await mkSeller("stall");
    const oldDom = await addDomain(s.biz, host("t1"));
    const newDom = await addDomain(s.biz, host("t2"));
    const checked = await addDomain(s.biz, host("t3"));
    const old = new Date(Date.now() - 10 * 60_000);
    await prisma.storefrontDomain.update({ where: { id: oldDom.id }, data: { createdAt: old } });
    await prisma.storefrontDomain.update({ where: { id: checked.id }, data: { createdAt: old, lastCheckedAt: new Date() } });
    await redis.del("dv:sweep");
    enq = [];
    await sweepStalledDomains();
    const ids = enq.map((e) => e.payload.domainId);
    expect(ids).toContain(oldDom.id);
    expect(ids).not.toContain(newDom.id);
    expect(ids).not.toContain(checked.id);
    expect(await sweepStalledDomains()).toBe(0);
    await redis.del("dv:sweep");
  });
});

describe("admin + probe endpoint + worker", () => {
  it("adminListDomains filters/limits; counts group by status", async () => {
    const s = await mkSeller("adm");
    const a = await addDomain(s.biz, host("ad"));
    const rows = await adminListDomains({ search: host("ad").toUpperCase(), status: "pending_dns" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a.id, storefrontId: s.sf, storefrontSlug: s.slug, sellerBusinessId: s.biz });
    expect(await adminListDomains({ search: host("ad"), status: "active" })).toEqual([]);
    expect((await adminListDomains({ limit: 100000 })).length).toBeLessThanOrEqual(200);
    expect((await adminDomainCounts()).pending_dns).toBeGreaterThanOrEqual(1);
  });
  it("domainCheckResponse only for registered hosts, port stripped, token matches probe", async () => {
    const s = await mkSeller("chk");
    const a = await addDomain(s.biz, host("ck"));
    expect(await domainCheckResponse(`${a.hostname.toUpperCase()}:443`)).toEqual({ host: a.hostname, token: domainCheckToken(a.hostname) });
    expect(await domainCheckResponse(`unknown-${run}.com`)).toBeNull();
  });
  it("worker wiring: queue consumer + scheduled jobs", async () => {
    expect(worker.name).toBe("domains");
    expect(worker.queues).toHaveLength(1);
    expect(worker.jobs!.map((j) => j.name).sort()).toEqual(["domains.flush-traffic", "domains.recheck-live", "domains.sweep-stalled"]);
    const flush = worker.jobs!.find((j) => j.name === "domains.flush-traffic")!;
    await redis.set("sfm:flush:lock", "1", "EX", 30);
    await flush.run();
    await redis.del("sfm:flush:lock");
    await flush.run();
    await redis.del("sfm:flush:lock");
    await redis.del("dv:daily", "dv:sweep");
    for (const n of ["domains.recheck-live", "domains.sweep-stalled"]) await worker.jobs!.find((j) => j.name === n)!.run();
    await redis.del("dv:daily", "dv:sweep");
  });
});

describe("resolveHost", () => {
  it("platform hosts answer without I/O; empty -> null", async () => {
    expect(await resolveHost("")).toBeNull();
    expect(await resolveHost("localhost:3000")).toEqual({ kind: "platform", storefrontSlug: null, canonicalHost: "localhost" });
    expect(await resolveHost(`www.${cfg.rootDomain}`)).toMatchObject({ kind: "platform" });
  });
  it("platform subdomain: only for live storefronts; canonical = primary active custom domain", async () => {
    const live = await mkSeller("sublive", "live");
    const draft = await mkSeller("subdraft", "draft");
    expect(await resolveHost(`${live.slug}.${cfg.rootDomain}`)).toEqual({ kind: "subdomain", storefrontSlug: live.slug, canonicalHost: `${live.slug}.${cfg.rootDomain}` });
    expect(await resolveHost(`${draft.slug}.${cfg.rootDomain}`)).toBeNull();
    expect(await resolveHost(`nonexistent-${run}.${cfg.rootDomain}`)).toBeNull();
    expect(await resolveHost(`a.b.${cfg.rootDomain}`)).toBeNull();
    const d = await addDomain(live.biz, host("sl"));
    await verifyNow(d.id, d.hostname, new MockEdgeProvider());
    expect(await resolveHost(`${live.slug}.${cfg.rootDomain}`)).toMatchObject({ canonicalHost: d.hostname });
  });
  it("custom domain of a non-live storefront never resolves even when active", async () => {
    const s = await mkSeller("susp", "live");
    const d = await addDomain(s.biz, host("su"));
    await verifyNow(d.id, d.hostname, new MockEdgeProvider());
    expect(await resolveHost(d.hostname)).not.toBeNull();
    await prisma.storefront.update({ where: { id: s.sf }, data: { status: "suspended" } });
    const { invalidateStorefrontHosts } = await import("../src/resolve");
    await invalidateStorefrontHosts(s.sf);
    expect(await resolveHost(d.hostname)).toBeNull();
  });
  it("storefrontCanonical falls back to the platform subdomain (and http for localhost root)", async () => {
    const s = await mkSeller("canon");
    expect(await storefrontCanonical(s.slug)).toBe(`http://${s.slug}.localhost:${process.env.WEB_PORT ?? 3000}`);
    expect(await storefrontCanonical(`ghost-${run}`)).toContain(`ghost-${run}.localhost`);
  });
});
