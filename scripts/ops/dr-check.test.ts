import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, formatReport, residencyChecks, runDrChecks, thresholdsFromEnv, type Fetcher } from "./dr-check";

const NOW = new Date("2026-09-30T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const ok = (body: unknown): ReturnType<Fetcher> => Promise.resolve({ ok: true, status: 200, json: async () => body });
const bad = (status: number): ReturnType<Fetcher> => Promise.resolve({ ok: false, status, json: async () => ({}) });

const goodEnv = {
  DR_PRIMARY_REGION: "ap-south-1", DR_SECONDARY_REGION: "ap-south-2", DATA_RESIDENCY_ENFORCE: "true",
  DATABASE_URL: "postgres://u:p@db.ap-south-1.rds.amazonaws.com:5432/cnote", REDIS_URL: "redis://cache.ap-south-1.amazonaws.com:6379", MEDIA_DRIVER: "s3", MEDIA_REGION: "ap-south-1",
  DR_SECONDARY_DATABASE_URL: "postgres://u:p@db.ap-south-2.rds.amazonaws.com:5432/cnote", DR_SECONDARY_REDIS_URL: "redis://cache.ap-south-2.amazonaws.com:6379", DR_SECONDARY_MEDIA_REGION: "ap-south-2",
  DR_PG_LAG_URL: "http://mon/pg", DR_WAL_ARCHIVE_URL: "http://mon/wal", DR_BACKUP_URL: "http://mon/backup", DR_REDIS_LAG_URL: "http://mon/redis", DR_MEDIA_REPLICATION_URL: "http://mon/media",
  DR_SECONDARY_HEALTH_URL: "https://api.dr.example.in/ready",
};
const healthy: Record<string, unknown> = {
  "http://mon/pg": { lagSeconds: 2 }, "http://mon/wal": { lastArchivedAt: ago(45) }, "http://mon/backup": { lastFullBackupAt: ago(3 * 3600), lastRestoreTestAt: ago(5 * 86_400) },
  "http://mon/redis": { lagSeconds: 1 }, "http://mon/media": { oldestPendingSeconds: 20 },
};
const fetcher = (over: Record<string, unknown | (() => ReturnType<Fetcher>)> = {}): Fetcher => async (url) => {
  const v = url in over ? over[url] : url === "https://api.dr.example.in/ready" ? { ready: true } : healthy[url];
  if (typeof v === "function") return (v as () => ReturnType<Fetcher>)();
  return ok(v);
};
const run = (env: Record<string, string | undefined>, over = {}, strict = false) => runDrChecks(env, { fetch: fetcher(over), now: () => NOW }, strict);
const by = (r: Awaited<ReturnType<typeof run>>, name: string) => r.results.find((c) => c.name.startsWith(name))!;

describe("dr-check", () => {
  it("passes a healthy two-region setup", async () => {
    const r = await run(goodEnv);
    expect(r.results.filter((c) => c.status !== "ok")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(formatReport(r)).toContain("RESULT: OK");
  });

  it("warns then fails as replica lag crosses the RPO thresholds", async () => {
    expect(by(await run(goodEnv, { "http://mon/pg": { lagSeconds: 45 } }), "postgres").status).toBe("warn");
    const r = await run(goodEnv, { "http://mon/pg": { lagSeconds: 61 } });
    expect(by(r, "postgres").status).toBe("fail");
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toContain("RESULT: FAIL");
    expect(by(await run(goodEnv, { "http://mon/pg": { lagSeconds: 8000 } }), "postgres").detail).toContain("2.2h");
  });

  it("fails on stale WAL archiving, stale base backups; warns when the restore drill is overdue or missing", async () => {
    expect(by(await run(goodEnv, { "http://mon/wal": { lastArchivedAt: ago(900) } }), "wal").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/backup": { lastFullBackupAt: ago(30 * 3600), lastRestoreTestAt: ago(86_400) } }), "base backup").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/backup": { lastFullBackupAt: ago(3600), lastRestoreTestAt: ago(40 * 86_400) } }), "base backup").status).toBe("warn");
    const never = by(await run(goodEnv, { "http://mon/backup": { lastFullBackupAt: ago(3600) } }), "base backup");
    expect(never.status).toBe("warn");
    expect(never.detail).toContain("never/unknown");
    expect(by(await run(goodEnv, { "http://mon/backup": {} }), "base backup").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/wal": { lastArchivedAt: "garbage" } }), "wal").status).toBe("fail");
  });

  it("fails on redis and object-storage backlog, and on unreadable signals", async () => {
    expect(by(await run(goodEnv, { "http://mon/redis": { lagSeconds: 900 } }), "redis").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/media": { oldestPendingSeconds: 3600 } }), "object").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/redis": {} }), "redis").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/media": {} }), "object").status).toBe("fail");
    expect(by(await run(goodEnv, { "http://mon/pg": {} }), "postgres").detail).toContain("missing");
    expect(by(await run(goodEnv, { "http://mon/pg": () => bad(500) }), "postgres").detail).toContain("HTTP 500");
    expect(by(await run(goodEnv, { "http://mon/pg": () => Promise.reject(new Error("ECONNREFUSED")) }), "postgres").detail).toContain("ECONNREFUSED");
    expect(by(await run(goodEnv, { "http://mon/pg": null }), "postgres").detail).toContain("not a JSON object");
    expect(by(await run(goodEnv, { "http://mon/pg": () => Promise.reject("weird") }), "postgres").detail).toContain("weird");
  });

  it("checks the secondary region answers readiness", async () => {
    expect(by(await run(goodEnv, { "https://api.dr.example.in/ready": () => bad(503) }), "secondary region").status).toBe("fail");
    expect(by(await run(goodEnv, { "https://api.dr.example.in/ready": () => Promise.reject(new Error("timeout")) }), "secondary region").detail).toContain("timeout");
    expect(by(await run(goodEnv, { "https://api.dr.example.in/ready": () => Promise.reject("x") }), "secondary region").status).toBe("fail");
  });

  it("sends the bearer token to the monitoring endpoints", async () => {
    const seen: (string | undefined)[] = [];
    const f: Fetcher = async (url, init) => { seen.push(init?.headers?.authorization); return ok(healthy[url] ?? {}); };
    await runDrChecks({ ...goodEnv, DR_CHECK_TOKEN: "t0k" }, { fetch: f, now: () => NOW });
    expect(seen.filter(Boolean)).toHaveLength(5);
    expect(seen).toContain("Bearer t0k");
  });

  it("skips unconfigured checks, and --strict turns skips into failures", async () => {
    const minimal = { DR_PRIMARY_REGION: "ap-south-1", DR_SECONDARY_REGION: "ap-south-2", DATA_RESIDENCY_ENFORCE: "true" };
    const lax = await run(minimal);
    expect(lax.results.filter((c) => c.status === "skip").length).toBeGreaterThanOrEqual(6);
    expect(lax.ok).toBe(true);
    expect((await run(minimal, {}, true)).ok).toBe(false);
    expect(formatReport(await run(minimal, {}, true))).toContain("(strict)");
  });

  it("uses process env and global fetch by default", async () => {
    const r = await runDrChecks({}, { fetch: undefined, now: undefined, timeoutMs: 50 });
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("applies threshold overrides from env", () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsFromEnv({ DR_PG_LAG_FAIL_SECONDS: "10", DR_PG_LAG_WARN_SECONDS: "x", DR_WAL_MAX_AGE_SECONDS: "1", DR_FULL_BACKUP_MAX_AGE_HOURS: "2", DR_RESTORE_TEST_MAX_AGE_DAYS: "3", DR_REDIS_LAG_FAIL_SECONDS: "4", DR_MEDIA_BACKLOG_FAIL_SECONDS: "5" }))
      .toEqual({ pgLagWarnSeconds: 30, pgLagFailSeconds: 10, walArchiveMaxAgeSeconds: 1, fullBackupMaxAgeHours: 2, restoreTestMaxAgeDays: 3, redisLagFailSeconds: 4, mediaBacklogFailSeconds: 5 });
  });
});

describe("residency checks (ADR-010)", () => {
  const find = (rs: ReturnType<typeof residencyChecks>, n: string) => rs.find((c) => c.name.startsWith(n))!;
  it("rejects non-India and identical DR regions", () => {
    expect(find(residencyChecks({ ...goodEnv, DR_SECONDARY_REGION: "eu-west-1" }), "dr regions").status).toBe("fail");
    expect(find(residencyChecks({ ...goodEnv, DR_SECONDARY_REGION: "ap-south-1" }), "dr regions").detail).toContain("both ap-south-1");
    expect(find(residencyChecks({ ...goodEnv, DR_PRIMARY_REGION: undefined }), "dr regions").status).toBe("skip");
  });
  it("requires the residency guard to be enforced", () => {
    expect(find(residencyChecks({ ...goodEnv, DATA_RESIDENCY_ENFORCE: "false" }), "data residency guard").status).toBe("fail");
  });
  it("flags a primary or secondary store outside India", () => {
    const primary = residencyChecks({ ...goodEnv, DATABASE_URL: "postgres://u:p@db.us-east-1.rds.amazonaws.com/x" });
    expect(primary.some((c) => c.name.startsWith("primary residency") && c.status === "fail")).toBe(true);
    const secondary = residencyChecks({ ...goodEnv, DR_SECONDARY_DATABASE_URL: "postgres://u:p@db.eu-west-1.rds.amazonaws.com/x" });
    expect(find(secondary, "secondary residency").status).toBe("fail");
    expect(find(residencyChecks({ ...goodEnv, DR_SECONDARY_DATABASE_URL: undefined, DR_SECONDARY_REDIS_URL: undefined, DR_SECONDARY_MEDIA_REGION: undefined }), "secondary residency").status).toBe("skip");
    const warn = residencyChecks({ ...goodEnv, DR_SECONDARY_DATABASE_URL: "postgres://u:p@somehost.example.com/x" });
    expect(find(warn, "secondary residency").status).toBe("warn");
  });
  it("reports a clean bill when everything is in India", () => {
    expect(find(residencyChecks(goodEnv), "secondary residency").status).toBe("ok");
    expect(find(residencyChecks(goodEnv), "primary residency").status).toBe("ok");
  });
});
