// pnpm ops:dr-check [--json] [--strict]
// Verifies the disaster-recovery posture described in docs/ops/dr-runbook.md from env-provided endpoints, so it runs
// unchanged against real monitoring in production and against mocks in tests / staging drills:
//   1. Postgres streaming-replica lag             DR_PG_LAG_URL           -> { "lagSeconds": number }
//   2. WAL archiving freshness (PITR)             DR_WAL_ARCHIVE_URL      -> { "lastArchivedAt": ISO-8601 }
//   3. Base backup freshness + restore drill age  DR_BACKUP_URL           -> { "lastFullBackupAt": ISO, "lastRestoreTestAt": ISO }
//   4. Redis replica lag                          DR_REDIS_LAG_URL        -> { "lagSeconds": number }
//   5. Object-storage replication backlog         DR_MEDIA_REPLICATION_URL-> { "oldestPendingSeconds": number }
//   6. Secondary region answers readiness         DR_SECONDARY_HEALTH_URL -> HTTP 2xx
//   7. Data residency (ADR-010): primary AND secondary stores are India regions, and the two regions differ.
// Each endpoint is typically a Prometheus/CloudWatch/Grafana JSON proxy or a tiny exporter next to the database.
// Exit 1 when any check FAILS. Unconfigured checks are "skip" (fail with --strict, which production cron uses).
import { pathToFileURL } from "node:url";
import { getResidencyReport } from "../../packages/compliance/src/residency";

export type Status = "ok" | "warn" | "fail" | "skip";
export interface CheckResult { name: string; status: Status; detail: string }
export interface DrReport { ok: boolean; strict: boolean; checkedAt: string; results: CheckResult[] }

export interface Thresholds {
  /** ADR-018/023 scale.md + dr-runbook.md targets. Postgres RPO <= 60s: alert at 30s, fail at 60s. */
  pgLagWarnSeconds: number; pgLagFailSeconds: number;
  walArchiveMaxAgeSeconds: number;
  fullBackupMaxAgeHours: number;
  restoreTestMaxAgeDays: number;
  redisLagFailSeconds: number;
  mediaBacklogFailSeconds: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  pgLagWarnSeconds: 30, pgLagFailSeconds: 60, walArchiveMaxAgeSeconds: 300, fullBackupMaxAgeHours: 26, restoreTestMaxAgeDays: 35, redisLagFailSeconds: 300, mediaBacklogFailSeconds: 900,
};

export interface HttpResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<HttpResponse>;
export interface DrDeps { fetch?: Fetcher; now?: () => Date; timeoutMs?: number }

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function thresholdsFromEnv(env: NodeJS.ProcessEnv): Thresholds {
  const d = DEFAULT_THRESHOLDS;
  return {
    pgLagWarnSeconds: num(env.DR_PG_LAG_WARN_SECONDS, d.pgLagWarnSeconds), pgLagFailSeconds: num(env.DR_PG_LAG_FAIL_SECONDS, d.pgLagFailSeconds),
    walArchiveMaxAgeSeconds: num(env.DR_WAL_MAX_AGE_SECONDS, d.walArchiveMaxAgeSeconds), fullBackupMaxAgeHours: num(env.DR_FULL_BACKUP_MAX_AGE_HOURS, d.fullBackupMaxAgeHours),
    restoreTestMaxAgeDays: num(env.DR_RESTORE_TEST_MAX_AGE_DAYS, d.restoreTestMaxAgeDays), redisLagFailSeconds: num(env.DR_REDIS_LAG_FAIL_SECONDS, d.redisLagFailSeconds),
    mediaBacklogFailSeconds: num(env.DR_MEDIA_BACKLOG_FAIL_SECONDS, d.mediaBacklogFailSeconds),
  };
}

/** Indian cloud regions the platform may use (mirrors packages/compliance residency: ADR-010). */
const INDIA_REGION = /^(ap-south-[12]|asia-south[12]|centralindia|southindia|westindia|jioindiacentral|jioindiawest|ap-mumbai-1|ap-hyderabad-1)$/i;

const skip = (name: string, why: string): CheckResult => ({ name, status: "skip", detail: `not configured (${why})` });

async function getJson(url: string, deps: Required<DrDeps>, token?: string): Promise<Record<string, unknown>> {
  const res = await deps.fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(deps.timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== "object") throw new Error("response is not a JSON object");
  return body as Record<string, unknown>;
}

const ageSeconds = (iso: unknown, now: Date): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, (now.getTime() - t) / 1000);
};
const fmt = (s: number) => (s >= 172_800 ? `${(s / 86_400).toFixed(1)}d` : s >= 7200 ? `${(s / 3600).toFixed(1)}h` : s >= 120 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(0)}s`);

export async function runDrChecks(env: NodeJS.ProcessEnv = process.env, d: DrDeps = {}, strict = false): Promise<DrReport> {
  const deps: Required<DrDeps> = { fetch: d.fetch ?? ((url, init) => fetch(url, init)), now: d.now ?? (() => new Date()), timeoutMs: d.timeoutMs ?? 10_000 };
  const t = thresholdsFromEnv(env);
  const token = env.DR_CHECK_TOKEN;
  const now = deps.now();
  const results: CheckResult[] = [];

  /** Runs one endpoint check; any transport/shape problem is a FAIL (an unreadable signal is not a healthy one). */
  const probe = async (name: string, url: string | undefined, evalBody: (b: Record<string, unknown>) => CheckResult) => {
    if (!url) return void results.push(skip(name, "endpoint env not set"));
    try {
      results.push(evalBody(await getJson(url, deps, token)));
    } catch (err) {
      results.push({ name, status: "fail", detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  await probe("postgres replica lag", env.DR_PG_LAG_URL, (b) => {
    const lag = typeof b.lagSeconds === "number" ? b.lagSeconds : NaN;
    if (Number.isNaN(lag)) return { name: "postgres replica lag", status: "fail", detail: "lagSeconds missing" };
    const status: Status = lag > t.pgLagFailSeconds ? "fail" : lag > t.pgLagWarnSeconds ? "warn" : "ok";
    return { name: "postgres replica lag", status, detail: `${fmt(lag)} (RPO target ${t.pgLagFailSeconds}s, warn ${t.pgLagWarnSeconds}s)` };
  });

  await probe("wal archive freshness (PITR)", env.DR_WAL_ARCHIVE_URL, (b) => {
    const age = ageSeconds(b.lastArchivedAt, now);
    if (age === null) return { name: "wal archive freshness (PITR)", status: "fail", detail: "lastArchivedAt missing or invalid" };
    return { name: "wal archive freshness (PITR)", status: age > t.walArchiveMaxAgeSeconds ? "fail" : "ok", detail: `last segment archived ${fmt(age)} ago (max ${fmt(t.walArchiveMaxAgeSeconds)})` };
  });

  await probe("base backup + restore drill", env.DR_BACKUP_URL, (b) => {
    const backup = ageSeconds(b.lastFullBackupAt, now);
    const restore = ageSeconds(b.lastRestoreTestAt, now);
    if (backup === null) return { name: "base backup + restore drill", status: "fail", detail: "lastFullBackupAt missing or invalid" };
    const backupBad = backup > t.fullBackupMaxAgeHours * 3600;
    const restoreBad = restore === null || restore > t.restoreTestMaxAgeDays * 86_400;
    return {
      name: "base backup + restore drill",
      // an untested backup is a warning about the process, a stale backup is an outage-in-waiting
      status: backupBad ? "fail" : restoreBad ? "warn" : "ok",
      detail: `full backup ${fmt(backup)} old (max ${t.fullBackupMaxAgeHours}h); restore test ${restore === null ? "never/unknown" : `${fmt(restore)} ago`} (max ${t.restoreTestMaxAgeDays}d)`,
    };
  });

  await probe("redis replica lag", env.DR_REDIS_LAG_URL, (b) => {
    const lag = typeof b.lagSeconds === "number" ? b.lagSeconds : NaN;
    if (Number.isNaN(lag)) return { name: "redis replica lag", status: "fail", detail: "lagSeconds missing" };
    return { name: "redis replica lag", status: lag > t.redisLagFailSeconds ? "fail" : "ok", detail: `${fmt(lag)} (max ${fmt(t.redisLagFailSeconds)}; the outbox in Postgres is the source of truth, Redis holds only derived state)` };
  });

  await probe("object storage replication", env.DR_MEDIA_REPLICATION_URL, (b) => {
    const pending = typeof b.oldestPendingSeconds === "number" ? b.oldestPendingSeconds : NaN;
    if (Number.isNaN(pending)) return { name: "object storage replication", status: "fail", detail: "oldestPendingSeconds missing" };
    return { name: "object storage replication", status: pending > t.mediaBacklogFailSeconds ? "fail" : "ok", detail: `oldest unreplicated object ${fmt(pending)} (max ${fmt(t.mediaBacklogFailSeconds)})` };
  });

  if (!env.DR_SECONDARY_HEALTH_URL) results.push(skip("secondary region readiness", "DR_SECONDARY_HEALTH_URL not set"));
  else {
    try {
      const res = await deps.fetch(env.DR_SECONDARY_HEALTH_URL, { signal: AbortSignal.timeout(deps.timeoutMs) });
      results.push({ name: "secondary region readiness", status: res.ok ? "ok" : "fail", detail: `HTTP ${res.status}` });
    } catch (err) {
      results.push({ name: "secondary region readiness", status: "fail", detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  results.push(...residencyChecks(env));

  const failed = results.some((r) => r.status === "fail") || (strict && results.some((r) => r.status === "skip"));
  return { ok: !failed, strict, checkedAt: now.toISOString(), results };
}

/** ADR-010: the DR region must be an India region too, and different from the primary. Reuses the app-level residency guard. */
export function residencyChecks(env: NodeJS.ProcessEnv): CheckResult[] {
  const out: CheckResult[] = [];
  const primary = env.DR_PRIMARY_REGION?.trim();
  const secondary = env.DR_SECONDARY_REGION?.trim();
  if (!primary || !secondary) out.push(skip("dr regions", "DR_PRIMARY_REGION / DR_SECONDARY_REGION"));
  else {
    const bad = [primary, secondary].filter((r) => !INDIA_REGION.test(r));
    out.push(
      bad.length ? { name: "dr regions are India regions", status: "fail", detail: `not an India region: ${bad.join(", ")}` }
        : primary.toLowerCase() === secondary.toLowerCase() ? { name: "dr regions are distinct", status: "fail", detail: `primary and secondary are both ${primary}` }
          : { name: "dr regions", status: "ok", detail: `${primary} -> ${secondary}, both India` },
    );
  }
  const enforced = env.DATA_RESIDENCY_ENFORCE === "true";
  out.push({ name: "data residency guard enforced", status: enforced ? "ok" : "fail", detail: enforced ? "DATA_RESIDENCY_ENFORCE=true" : "DATA_RESIDENCY_ENFORCE must be true in production, in BOTH regions" });
  const primaryReport = getResidencyReport(env);
  out.push(...primaryReport.checks.filter((c) => c.status !== "ok").map<CheckResult>((c) => ({ name: `primary residency: ${c.name}`, status: c.status === "violation" ? "fail" : "warn", detail: `${c.value}: ${c.note}` })));
  if (!primaryReport.checks.some((c) => c.status !== "ok")) out.push({ name: "primary residency", status: "ok", detail: `${primaryReport.checks.length} stores checked` });
  const s = env.DR_SECONDARY_DATABASE_URL || env.DR_SECONDARY_REDIS_URL || env.DR_SECONDARY_MEDIA_REGION;
  if (!s) out.push(skip("secondary residency", "DR_SECONDARY_DATABASE_URL / DR_SECONDARY_REDIS_URL / DR_SECONDARY_MEDIA_REGION"));
  else {
    const rep = getResidencyReport({
      ...env, DATABASE_URL: env.DR_SECONDARY_DATABASE_URL, LIVE_DATABASE_URL: env.DR_SECONDARY_LIVE_DATABASE_URL, REDIS_URL: env.DR_SECONDARY_REDIS_URL,
      MEDIA_REGION: env.DR_SECONDARY_MEDIA_REGION, MEDIA_ENDPOINT: env.DR_SECONDARY_MEDIA_ENDPOINT,
    });
    const problems = rep.checks.filter((c) => c.status !== "ok");
    out.push(problems.length ? { name: "secondary residency", status: problems.some((c) => c.status === "violation") ? "fail" : "warn", detail: problems.map((c) => `${c.name}=${c.value} (${c.note})`).join("; ") }
      : { name: "secondary residency", status: "ok", detail: `${rep.checks.length} stores checked` });
  }
  return out;
}

export function formatReport(r: DrReport): string {
  const icon: Record<Status, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const lines = r.results.map((c) => `${icon[c.status]}  ${c.name.padEnd(36)} ${c.detail}`);
  return [`DR check @ ${r.checkedAt}${r.strict ? " (strict)" : ""}`, ...lines, r.ok ? "RESULT: OK" : "RESULT: FAIL"].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  runDrChecks(process.env, {}, args.includes("--strict"))
    .then((r) => {
      console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    });
}
