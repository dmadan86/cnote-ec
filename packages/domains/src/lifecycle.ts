import { DomainError, emit, getJobQueue, rateLimit, redis } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { domainsConfig } from "./config";
import { createPublicResolver } from "./dns";
import { getEdgeProvider } from "./edge";
import { validateHostname, type DomainKind } from "./hostname";
import { buildExpectedRecords, newVerifyToken, type DnsRecord, type ExpectedRecords } from "./records";
import { invalidateStorefrontHosts } from "./resolve";
import { defaultProbe, domainCheckToken, evaluateDomain, type DomainStatusName, type EvalDeps, type LastCheck } from "./verify";

declare module "@cnote/core" {
  interface JobTopics {
    /** one verification step for a domain; `gen` lets a newer chain supersede stale delayed jobs */
    "domain.verify": { domainId: string; gen?: number };
  }
}

export const VERIFY_TOPIC = "domain.verify" as const;

export interface DomainView {
  id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatusName;
  isPrimary: boolean;
  /** what the seller must configure */
  records: DnsRecord[];
  /** extra records the edge provider asked for (certificate validation), when any */
  providerRecords: DnsRecord[];
  note?: string;
  /** what we observed on the last check vs what we expected */
  diagnostics: LastCheck | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  checkCount: number;
  url: string | null;
}

type Row = Prisma.StorefrontDomainGetPayload<object>;

export function toView(row: Row): DomainView {
  const exp = row.expectedRecords as unknown as ExpectedRecords;
  const last = (row.lastCheck as unknown as LastCheck | null) ?? null;
  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind as DomainKind,
    status: row.status as DomainStatusName,
    isPrimary: row.isPrimary,
    records: exp.records,
    providerRecords: last?.edge?.records ?? [],
    note: exp.note,
    diagnostics: last,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    checkCount: row.checkCount,
    url: row.status === "active" ? `https://${row.hostname}` : null,
  };
}

async function storefrontOf(sellerBusinessId: string) {
  const sf = await prisma.storefront.findUnique({ where: { sellerBusinessId }, select: { id: true, slug: true, sellerBusinessId: true } });
  if (!sf) throw new DomainError("not_found", "Set up your storefront before connecting a domain.", undefined, "domains.setUpStorefrontBeforeConnecting");
  return sf;
}

async function ownedDomain(sellerBusinessId: string, domainId: string) {
  const row = await prisma.storefrontDomain.findUnique({ where: { id: domainId }, include: { storefront: { select: { sellerBusinessId: true, slug: true } } } });
  if (!row || row.storefront.sellerBusinessId !== sellerBusinessId) throw new DomainError("not_found", "Domain not found.", undefined, "domains.domainNotFound");
  return row;
}

// ---- verification scheduling ------------------------------------------------------------------

const genKey = (id: string) => `dv:gen:${id}`;

/** Start a fresh verification chain (supersedes any delayed jobs of an older chain). */
export async function startVerification(domainId: string, delayMs = 0): Promise<void> {
  const gen = await redis.incr(genKey(domainId));
  await redis.expire(genKey(domainId), 30 * 24 * 3600);
  await getJobQueue().enqueue(VERIFY_TOPIC, { domainId, gen }, { delayMs: delayMs || undefined, dedupeKey: `${domainId}:${gen}`, maxAttempts: 5 });
}

async function scheduleNext(domainId: string, gen: number | undefined, delayMs: number): Promise<void> {
  await getJobQueue().enqueue(VERIFY_TOPIC, { domainId, gen }, { delayMs, dedupeKey: `${domainId}:${gen ?? 0}:${Date.now()}`, maxAttempts: 5 });
}

// ---- seller operations ------------------------------------------------------------------------

/** Connect a hostname to the seller's storefront and start DNS verification. */
export async function addDomain(sellerBusinessId: string, hostnameInput: string): Promise<DomainView> {
  const cfg = domainsConfig();
  if (!(await rateLimit(`domains:add:${sellerBusinessId}`, 10, 3600))) throw new DomainError("rate_limited", "Too many attempts. Please try again in an hour.", undefined, "domains.tooManyAttemptsTryAgain");
  const sf = await storefrontOf(sellerBusinessId);
  const { hostname, kind } = validateHostname(hostnameInput, cfg);
  const count = await prisma.storefrontDomain.count({ where: { storefrontId: sf.id } });
  if (count >= cfg.maxDomainsPerStorefront) throw new DomainError("conflict", `You can connect up to ${cfg.maxDomainsPerStorefront} domains. Remove one first.`, undefined, "domains.connectUpDomainsRemoveOne", { maxDomainsPerStorefront: cfg.maxDomainsPerStorefront });
  if (await prisma.storefrontDomain.findUnique({ where: { hostname }, select: { id: true } })) {
    throw new DomainError("conflict", "That domain is already connected to a storefront. If it is yours, contact support.", undefined, "domains.domainAlreadyConnectedStorefrontIf");
  }
  const verifyToken = newVerifyToken();
  const expected = buildExpectedRecords(hostname, kind, verifyToken, cfg);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.storefrontDomain.create({ data: { storefrontId: sf.id, hostname, kind, status: "pending_dns", verifyToken, expectedRecords: expected as unknown as Prisma.InputJsonValue } });
    await emit(tx, "StorefrontDomainStatusChanged", { type: "StorefrontDomain", id: created.id }, { domainId: created.id, storefrontId: sf.id, sellerBusinessId, hostname, from: "none", to: "pending_dns", error: null });
    return created;
  });
  await startVerification(row.id);
  return toView(row);
}

export async function listDomains(sellerBusinessId: string): Promise<DomainView[]> {
  const sf = await prisma.storefront.findUnique({ where: { sellerBusinessId }, select: { id: true } });
  if (!sf) return [];
  const rows = await prisma.storefrontDomain.findMany({ where: { storefrontId: sf.id }, orderBy: { createdAt: "asc" } });
  return rows.map(toView);
}

/** What the seller sees when no custom domain is connected yet. */
export async function domainSetupInfo(sellerBusinessId: string): Promise<{ slug: string | null; platformHost: string | null; cnameTarget: string; apexIps: string[]; max: number; provider: string }> {
  const cfg = domainsConfig();
  const sf = await prisma.storefront.findUnique({ where: { sellerBusinessId }, select: { slug: true } });
  return { slug: sf?.slug ?? null, platformHost: sf ? `${sf.slug}.${cfg.rootDomain}` : null, cnameTarget: cfg.cnameTarget, apexIps: cfg.apexIps, max: cfg.maxDomainsPerStorefront, provider: cfg.provider };
}

/** Delete a domain (edge hostname best-effort, then the row). Used by sellers and staff. */
export async function removeDomainById(domainId: string): Promise<void> {
  const row = await prisma.storefrontDomain.findUnique({ where: { id: domainId }, include: { storefront: { select: { sellerBusinessId: true } } } });
  if (!row) throw new DomainError("not_found", "Domain not found.", undefined, "domains.domainNotFound");
  if (row.providerRef) {
    try {
      await getEdgeProvider().delete(row.providerRef);
    } catch (err) {
      console.error(`[domains] edge delete failed for ${row.hostname}:`, err instanceof Error ? err.message : err);
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.storefrontDomain.delete({ where: { id: row.id } });
    if (row.isPrimary) {
      const next = await tx.storefrontDomain.findFirst({ where: { storefrontId: row.storefrontId, status: "active" }, orderBy: { activatedAt: "asc" } });
      if (next) await tx.storefrontDomain.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    await emit(tx, "StorefrontDomainStatusChanged", { type: "StorefrontDomain", id: row.id }, { domainId: row.id, storefrontId: row.storefrontId, sellerBusinessId: row.storefront.sellerBusinessId, hostname: row.hostname, from: row.status, to: "removed", error: null });
  });
  await redis.del(genKey(row.id)).catch(() => undefined);
  await invalidateStorefrontHosts(row.storefrontId, [row.hostname]);
}

export async function removeDomain(sellerBusinessId: string, domainId: string): Promise<void> {
  await ownedDomain(sellerBusinessId, domainId);
  await removeDomainById(domainId);
}

/** Make an ACTIVE domain the canonical host; other hosts 301 to it. */
export async function setPrimary(sellerBusinessId: string, domainId: string): Promise<void> {
  const row = await ownedDomain(sellerBusinessId, domainId);
  if (row.status !== "active") throw new DomainError("conflict", "Only a domain that is active can be made primary.", undefined, "domains.onlyDomainActiveMadePrimary");
  await prisma.$transaction([
    prisma.storefrontDomain.updateMany({ where: { storefrontId: row.storefrontId, isPrimary: true }, data: { isPrimary: false } }),
    prisma.storefrontDomain.update({ where: { id: row.id }, data: { isPrimary: true } }),
  ]);
  await invalidateStorefrontHosts(row.storefrontId);
}

/** Seller "Re-check now": rate limited (5 per 10 minutes per domain), restarts the 72h pending window. */
export async function requestRecheck(sellerBusinessId: string, domainId: string): Promise<void> {
  const row = await ownedDomain(sellerBusinessId, domainId);
  if (!(await rateLimit(`domains:recheck:${row.id}`, 5, 600))) throw new DomainError("rate_limited", "You have re-checked a lot. Please wait a few minutes.", undefined, "domains.reCheckedLotWaitFew");
  await forceRecheck(row.id);
}

/** Staff / internal: restart verification for a domain now. */
export async function forceRecheck(domainId: string): Promise<void> {
  const row = await prisma.storefrontDomain.findUnique({ where: { id: domainId } });
  if (!row) throw new DomainError("not_found", "Domain not found.", undefined, "domains.domainNotFound");
  const last = (row.lastCheck as unknown as LastCheck | null) ?? null;
  if (last) {
    await prisma.storefrontDomain.update({ where: { id: row.id }, data: { lastCheck: { ...last, windowStartedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue } });
  }
  await startVerification(row.id);
}

// ---- verification step (queue handler) --------------------------------------------------------

export interface ProcessDeps extends Partial<EvalDeps> {
  lock?: boolean;
}

/**
 * One verification step: evaluate, persist status/diagnostics, emit status events for every hop, invalidate host
 * caches when serving state changed, and schedule the next step (backoff) unless the chain is finished.
 */
export async function processDomainCheck(domainId: string, gen?: number, deps: ProcessDeps = {}): Promise<{ status: DomainStatusName; changed: boolean } | null> {
  if (gen !== undefined) {
    const cur = Number((await redis.get(genKey(domainId)).catch(() => null)) ?? 0);
    if (gen < cur) return null; // superseded by a newer chain
  }
  const lockKey = `dv:lock:${domainId}`;
  if (deps.lock !== false && (await redis.set(lockKey, "1", "EX", 120, "NX")) !== "OK") return null;
  try {
    const row = await prisma.storefrontDomain.findUnique({ where: { id: domainId }, include: { storefront: { select: { sellerBusinessId: true } } } });
    if (!row || row.status === "removed") return null;
    const cfg = deps.cfg ?? domainsConfig();
    const last = (row.lastCheck as unknown as LastCheck | null) ?? null;
    const outcome = await evaluateDomain(
      {
        hostname: row.hostname,
        kind: row.kind as DomainKind,
        status: row.status as DomainStatusName,
        verifyToken: row.verifyToken,
        providerRef: row.providerRef,
        checkCount: row.checkCount,
        createdAt: row.createdAt,
        verifiedAt: row.verifiedAt,
        windowStartedAt: last?.windowStartedAt ? new Date(last.windowStartedAt) : row.createdAt,
      },
      { resolver: deps.resolver ?? createPublicResolver(cfg), edge: deps.edge ?? getEdgeProvider(), probe: deps.probe ?? defaultProbe(cfg), cfg, now: deps.now },
    );
    const from = row.status as DomainStatusName;
    const changed = outcome.status !== from;
    const now = deps.now?.() ?? new Date();
    await prisma.$transaction(async (tx) => {
      const reached = new Set(outcome.walk);
      const data: Prisma.StorefrontDomainUpdateInput = {
        status: outcome.status,
        lastCheck: outcome.lastCheck as unknown as Prisma.InputJsonValue,
        lastError: outcome.error,
        checkCount: { increment: 1 },
        lastCheckedAt: now,
        providerRef: outcome.providerRef,
      };
      if (reached.has("verified") && !row.verifiedAt) data.verifiedAt = now;
      if (outcome.status === "active" && from !== "active") {
        data.activatedAt = now;
        const hasPrimary = await tx.storefrontDomain.count({ where: { storefrontId: row.storefrontId, isPrimary: true, status: "active", id: { not: row.id } } });
        if (!hasPrimary) data.isPrimary = true;
      }
      if (outcome.status !== "active" && row.isPrimary && from === "active") data.isPrimary = false;
      await tx.storefrontDomain.update({ where: { id: row.id }, data });
      for (let i = 1; i < outcome.walk.length; i++) {
        const isLast = i === outcome.walk.length - 1;
        await emit(tx, "StorefrontDomainStatusChanged", { type: "StorefrontDomain", id: row.id }, { domainId: row.id, storefrontId: row.storefrontId, sellerBusinessId: row.storefront.sellerBusinessId, hostname: row.hostname, from: outcome.walk[i - 1]!, to: outcome.walk[i]!, error: isLast ? outcome.error : null });
      }
      if (from === "active" && outcome.status !== "active" && row.isPrimary) {
        const next = await tx.storefrontDomain.findFirst({ where: { storefrontId: row.storefrontId, status: "active", id: { not: row.id } }, orderBy: { activatedAt: "asc" } });
        if (next) await tx.storefrontDomain.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
    if (from === "active" || outcome.status === "active") await invalidateStorefrontHosts(row.storefrontId);
    if (outcome.requeueMs !== null) await scheduleNext(row.id, gen, outcome.requeueMs);
    return { status: outcome.status, changed };
  } finally {
    if (deps.lock !== false) await redis.del(lockKey).catch(() => undefined);
  }
}

// ---- scheduled sweeps -------------------------------------------------------------------------

async function once(key: string, ttlS: number): Promise<boolean> {
  return (await redis.set(key, "1", "EX", ttlS, "NX")) === "OK";
}

/** Daily: re-check active domains (and previously verified misconfigured ones, so they self-heal); drop stale unverified claims. */
export async function recheckLiveDomains(): Promise<number> {
  if (!(await once("dv:daily", 20 * 3600))) return 0;
  const rows = await prisma.storefrontDomain.findMany({
    where: { OR: [{ status: "active" }, { status: "misconfigured", verifiedAt: { not: null } }] },
    select: { id: true },
  });
  for (const r of rows) await startVerification(r.id, Math.floor(Math.random() * 3 * 3600_000));
  await prisma.storefrontDomain.deleteMany({ where: { verifiedAt: null, status: { in: ["pending_dns", "misconfigured"] }, createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } } });
  return rows.length;
}

/** Hourly safety net: restart chains that stalled (lost delayed job, worker down) for in-progress domains. */
export async function sweepStalledDomains(): Promise<number> {
  if (!(await once("dv:sweep", 50 * 60))) return 0;
  const rows = await prisma.storefrontDomain.findMany({
    where: {
      status: { in: ["pending_dns", "verifying", "verified", "provisioning_tls"] },
      createdAt: { lt: new Date(Date.now() - 5 * 60_000) },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - 65 * 60_000) } }],
    },
    select: { id: true },
  });
  for (const r of rows) await startVerification(r.id);
  return rows.length;
}

// ---- admin ------------------------------------------------------------------------------------

export interface AdminDomainRow extends DomainView {
  storefrontId: string;
  storefrontSlug: string;
  sellerBusinessId: string;
}

export async function adminListDomains(opts: { status?: DomainStatusName; search?: string; limit?: number } = {}): Promise<AdminDomainRow[]> {
  const rows = await prisma.storefrontDomain.findMany({
    where: { status: opts.status, hostname: opts.search ? { contains: opts.search.toLowerCase() } : undefined },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.limit ?? 100, 200),
    include: { storefront: { select: { slug: true, sellerBusinessId: true } } },
  });
  return rows.map((r) => ({ ...toView(r), storefrontId: r.storefrontId, storefrontSlug: r.storefront.slug, sellerBusinessId: r.storefront.sellerBusinessId }));
}

export async function adminDomainCounts(): Promise<Record<string, number>> {
  const g = await prisma.storefrontDomain.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(g.map((x) => [x.status, x._count._all]));
}

// ---- reachability probe endpoint --------------------------------------------------------------

/** Body for GET /.well-known/cnote-domain-check on a host; null unless the host is a registered custom domain. */
export async function domainCheckResponse(hostInput: string): Promise<{ host: string; token: string } | null> {
  const host = hostInput.trim().toLowerCase().replace(/:\d+$/, "");
  const row = await prisma.storefrontDomain.findUnique({ where: { hostname: host }, select: { id: true } });
  return row ? { host, token: domainCheckToken(host) } : null;
}
