import { prisma, type Tx } from "@cnote/db";
import { latestEventId, readEvents, scanBound } from "./log";
import { PROJECTIONS } from "./projections";
import type { Projection } from "./types";

export interface RunOptions {
  /** events per transaction (default ANALYTICS_BATCH_SIZE or 500) */
  batchSize?: number;
  /**
   * Safety lag: only events older than this are consumed, so a transaction that took a lower id but commits later is never
   * skipped (default ANALYTICS_LAG_MS or 30s; must exceed the longest write transaction). Backfill uses 0.
   */
  lagMs?: number;
  /** stop after this many batches per projection per call (default 20) so a job tick stays short */
  maxBatches?: number;
  now?: () => Date;
}

export interface RunResult {
  projection: string;
  /** events applied (of this projection's types) */
  applied: number;
  /** log positions advanced past, including events of other types */
  scanned: number;
  lastEventId: string;
  caughtUp: boolean;
  /** another worker held the projection's checkpoint lock */
  skipped: boolean;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const tx60 = { timeout: 60_000, maxWait: 10_000 } as const;

/** Dependency-first order; throws on unknown or cyclic dependencies. */
export function orderProjections(list: readonly Projection[] = PROJECTIONS): Projection[] {
  const byName = new Map(list.map((p) => [p.name, p]));
  const out: Projection[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (p: Projection) => {
    if (state.get(p.name) === "done") return;
    if (state.get(p.name) === "visiting") throw new Error(`analytics projection cycle at ${p.name}`);
    state.set(p.name, "visiting");
    for (const d of p.dependsOn ?? []) {
      const dep = byName.get(d);
      if (!dep) throw new Error(`analytics projection ${p.name} depends on unknown projection ${d}`);
      visit(dep);
    }
    state.set(p.name, "done");
    out.push(p);
  };
  list.forEach(visit);
  return out;
}

/** Names of `names` plus every projection that (transitively) depends on them: what a reset must also rebuild. */
export function withDependents(names: string[], list: readonly Projection[] = PROJECTIONS): string[] {
  const set = new Set(names);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) if (!set.has(p.name) && (p.dependsOn ?? []).some((d) => set.has(d))) (set.add(p.name), (grew = true));
  }
  return list.filter((p) => set.has(p.name)).map((p) => p.name);
}

async function ensureCheckpoint(p: Projection, startAfter?: bigint) {
  await prisma.analyticsCheckpoint.upsert({ where: { projection: p.name }, create: { projection: p.name, version: p.version, lastEventId: startAfter ?? 0n }, update: {} });
}

/** Applies ONE batch. Exactly-once: apply + checkpoint advance share a transaction guarded by a row lock. */
async function runBatch(p: Projection, opts: Required<Pick<RunOptions, "batchSize" | "lagMs">> & { now: () => Date }): Promise<Omit<RunResult, "projection">> {
  return prisma.$transaction(async (tx: Tx) => {
    const locked = await tx.$queryRaw<{ last_event_id: bigint; version: number }[]>`
      SELECT last_event_id, version FROM analytics_checkpoints WHERE projection = ${p.name} FOR UPDATE SKIP LOCKED`;
    const cp = locked[0];
    if (!cp) return { applied: 0, scanned: 0, lastEventId: "0", caughtUp: false, skipped: true };
    if (cp.version !== p.version) {
      throw new Error(`analytics projection ${p.name}: tables are version ${cp.version}, code is version ${p.version}; run backfill --reset ${p.name}`);
    }
    let cap: bigint | null = null;
    if (p.dependsOn?.length) {
      const deps = await tx.analyticsCheckpoint.findMany({ where: { projection: { in: [...p.dependsOn] } }, select: { lastEventId: true } });
      cap = deps.length < p.dependsOn.length ? 0n : deps.reduce((m, d) => (d.lastEventId < m ? d.lastEventId : m), deps[0]!.lastEventId);
    }
    const cutoff = new Date(opts.now().getTime() - opts.lagMs);
    const bound = await scanBound(tx, cp.last_event_id, opts.batchSize, cutoff, cap);
    if (bound === null) return { applied: 0, scanned: 0, lastEventId: String(cp.last_event_id), caughtUp: true, skipped: false };
    const events = await readEvents(tx, cp.last_event_id, bound, p.types);
    if (events.length) await p.process(tx, events);
    await tx.analyticsCheckpoint.update({
      where: { projection: p.name },
      data: { lastEventId: bound, eventsApplied: { increment: events.length }, updatedAt: new Date() },
    });
    return { applied: events.length, scanned: Number(bound - cp.last_event_id), lastEventId: String(bound), caughtUp: false, skipped: false };
  }, tx60);
}

/** Advances one projection until it is caught up (or maxBatches). `startAfter` seeds a NEW checkpoint (tests, cutovers). */
export async function runProjection(p: Projection, options: RunOptions & { startAfter?: bigint } = {}): Promise<RunResult> {
  const opts = {
    batchSize: options.batchSize ?? (num(process.env.ANALYTICS_BATCH_SIZE, 500) || 500),
    lagMs: options.lagMs ?? num(process.env.ANALYTICS_LAG_MS, 30_000),
    now: options.now ?? (() => new Date()),
  };
  await ensureCheckpoint(p, options.startAfter);
  const total: RunResult = { projection: p.name, applied: 0, scanned: 0, lastEventId: "0", caughtUp: false, skipped: false };
  for (let i = 0; i < (options.maxBatches ?? 20); i++) {
    const r = await runBatch(p, opts);
    total.applied += r.applied;
    total.scanned += r.scanned;
    total.lastEventId = r.lastEventId;
    total.skipped = r.skipped;
    if (r.skipped || r.caughtUp) {
      total.caughtUp = r.caughtUp;
      break;
    }
  }
  return total;
}

/** One scheduler tick: every projection, dependency-first. Safe to run concurrently on many workers. */
export async function runProjections(options: RunOptions = {}, list: readonly Projection[] = PROJECTIONS): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const p of orderProjections(list)) out.push(await runProjection(p, options));
  return out;
}

/**
 * Rebuild from the log. With `reset`, the named projections AND their dependents are wiped and re-read from event id 0
 * (checkpoint reset and table wipe are one transaction, taken under the checkpoint lock, so no runner interleaves).
 * Without `reset` it just drains to the head of the log with no safety lag. Deterministic: the same log always yields the
 * same tables (the `biz:` state refs are frozen at first resolution).
 */
export async function backfill(opts: { projections?: string[]; reset?: boolean; batchSize?: number } = {}, list: readonly Projection[] = PROJECTIONS): Promise<RunResult[]> {
  const known = new Set(list.map((p) => p.name));
  for (const n of opts.projections ?? []) if (!known.has(n)) throw new Error(`unknown analytics projection "${n}" (known: ${[...known].join(", ")})`);
  const names = opts.projections?.length ? (opts.reset ? withDependents(opts.projections, list) : opts.projections) : list.map((p) => p.name);
  const chosen = orderProjections(list).filter((p) => names.includes(p.name));
  if (opts.reset) {
    for (const p of [...chosen].reverse()) await resetOne(p);
  }
  const results: RunResult[] = [];
  for (const p of chosen) {
    let last: RunResult;
    do {
      last = await runProjection(p, { batchSize: opts.batchSize, lagMs: 0, maxBatches: 1000 });
    } while (!last.caughtUp && !last.skipped);
    results.push(last);
  }
  return results;
}

async function resetOne(p: Projection) {
  await ensureCheckpoint(p);
  await prisma.$transaction(async (tx: Tx) => {
    await tx.$queryRaw`SELECT 1 FROM analytics_checkpoints WHERE projection = ${p.name} FOR UPDATE`;
    await p.reset(tx);
    await tx.analyticsCheckpoint.update({ where: { projection: p.name }, data: { lastEventId: 0n, eventsApplied: 0n, version: p.version, updatedAt: new Date() } });
  }, tx60);
}

export interface ProjectionStatus {
  projection: string;
  version: number;
  lastEventId: string;
  eventsApplied: string;
  /** log head minus checkpoint (events not yet projected, including other types) */
  lagEvents: string;
  updatedAt: string;
}

export async function getProjectionStatus(): Promise<ProjectionStatus[]> {
  const head = await latestEventId();
  const rows = await prisma.analyticsCheckpoint.findMany({ orderBy: { projection: "asc" } });
  return rows.map((r) => ({
    projection: r.projection, version: r.version, lastEventId: String(r.lastEventId), eventsApplied: String(r.eventsApplied),
    lagEvents: String(head > r.lastEventId ? head - r.lastEventId : 0n), updatedAt: r.updatedAt.toISOString(),
  }));
}
