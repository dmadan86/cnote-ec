import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const opt = vi.hoisted(() => ({ voice: vi.fn(), wa: vi.fn() }));
vi.mock("@cnote/catalogue", async (orig) => ({ ...(await orig<object>()), purgeExpiredVoiceNotes: opt.voice }));
vi.mock("@cnote/whatsapp", async (orig) => ({ ...(await orig<object>()), purgeWhatsAppMessages: opt.wa }));

import { RETENTION_POLICIES, describePolicies, listRetentionRuns, runDueRetention, runRetention, toCount, windowDays, worker, type RetentionPolicy } from "../src";
import { optionalPurge } from "../src/retention";

const mark = `test.${randomUUID().slice(0, 8)}`;
const fake = (name: string, run: RetentionPolicy["run"]): RetentionPolicy => ({
  name: `${mark}.${name}`, module: "test", description: "d", legalBasis: "l", envKey: "TEST_FAKE", defaultDays: 10, supportsDryRun: true, run,
});
const now = new Date("2026-06-30T00:00:00Z");

beforeEach(() => {
  opt.voice.mockReset().mockResolvedValue(2);
  opt.wa.mockReset().mockResolvedValue({ purged: 4 });
});
afterAll(() => prisma.retentionRun.deleteMany({ where: { module: "test" } }));

describe("registry", () => {
  it("has unique names, sane defaults and env-overridable windows", () => {
    const names = RETENTION_POLICIES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of RETENTION_POLICIES) {
      expect(p.legalBasis.length).toBeGreaterThan(5);
      expect(windowDays(p, {})).toBe(p.defaultDays);
    }
    const p = RETENTION_POLICIES.find((x) => x.name.startsWith("reviews."))!;
    expect(windowDays(p, { RETENTION_REJECTED_UGC_DAYS: "30" })).toBe(30);
    expect(windowDays(p, { RETENTION_REJECTED_UGC_DAYS: "0" })).toBe(p.defaultDays);
    expect(describePolicies({ RETENTION_REJECTED_UGC_DAYS: "30" }).find((x) => x.name === p.name)!.windowDays).toBe(30);
  });

  it("toCount normalises unknown purge results", () => {
    expect(toCount(3)).toBe(3);
    expect(toCount({ purged: 2 })).toBe(2);
    expect(toCount({ deleted: 5 })).toBe(5);
    expect(toCount({ nothing: 1 })).toBe(0);
    expect(toCount(null)).toBe(0);
    expect(toCount("x")).toBe(0);
  });

  it("optionalPurge is a no-op when the export is absent or on dry-run", async () => {
    expect(await optionalPurge({}, "missing", [], false)).toBe(0);
    expect(await optionalPurge({ f: async () => 9 }, "f", [], true)).toBe(0);
    expect(await optionalPurge({ f: async () => 9 }, "f", [], false)).toBe(9);
  });

  it("guarded voice/whatsapp policies call the optional exports when present", async () => {
    const byName = (n: string) => RETENTION_POLICIES.find((p) => p.name === n)!;
    expect(await byName("catalogue.voice_notes_expired").run(now, { dryRun: false })).toBe(2);
    expect(await byName("whatsapp.message_bodies_retention").run(now, { dryRun: false })).toBe(4);
    expect(await byName("catalogue.voice_notes_expired").run(now, { dryRun: true })).toBe(0);
    expect(opt.voice).toHaveBeenCalledTimes(1);
  });

  it("every module-backed policy supports a dry run against the real database without changing data", async () => {
    for (const p of RETENTION_POLICIES.filter((x) => x.supportsDryRun)) {
      const n = await p.run(new Date(Date.now() - 3650 * 86_400_000), { dryRun: true });
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it("worker registers hourly retention and SLA jobs", () => {
    expect(worker.name).toBe("compliance");
    expect(worker.jobs.map((j) => j.name)).toEqual(["retention", "grievance-sla"]);
  });
});

describe("runRetention", () => {
  it("writes a RetentionRun per policy with the computed cutoff, isolating failures", async () => {
    const cutoffs: Date[] = [];
    const ok = fake("ok", async (before) => (cutoffs.push(before), 7));
    const bad = fake("bad", async () => {
      throw new Error("db down");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runRetention({ policies: [bad, ok], now, env: {} });
    err.mockRestore();
    expect(res.map((r) => [r.purged, r.error])).toEqual([[0, "db down"], [7, null]]);
    expect(cutoffs[0]!.toISOString()).toBe("2026-06-20T00:00:00.000Z");
    const rows = await prisma.retentionRun.findMany({ where: { policy: { startsWith: mark } }, orderBy: { startedAt: "asc" } });
    expect(rows.map((r) => [r.policy.split(".").pop(), r.purged, r.error])).toEqual([["bad", 0, "db down"], ["ok", 7, null]]);
    expect(rows[1]!.finishedAt.getTime()).toBeGreaterThanOrEqual(rows[1]!.startedAt.getTime());
    expect(rows[0]!.module).toBe("test");
    expect((await listRetentionRuns(500)).some((r) => r.policy.startsWith(mark))).toBe(true);
    expect((await listRetentionRuns(0)).length).toBeLessThanOrEqual(1);
  });

  it("uses env window overrides; dry-run rows are labelled and pass dryRun to the policy", async () => {
    const seen: { before: Date; dryRun: boolean }[] = [];
    const p = fake("dry", async (before, o) => (seen.push({ before, dryRun: o.dryRun }), 3));
    const res = await runRetention({ policies: [p], dryRun: true, now, env: { RETENTION_TEST_FAKE_DAYS: "40" } });
    expect(res[0]).toMatchObject({ dryRun: true, purged: 3 });
    expect(seen[0]!.before.toISOString()).toBe("2026-05-21T00:00:00.000Z");
    expect(seen[0]!.dryRun).toBe(true);
    expect(await prisma.retentionRun.count({ where: { policy: `${mark}.dry (dry-run)` } })).toBe(1);
  });

  it("default policy list runs against the real modules with a huge window (nothing eligible)", async () => {
    const res = await runRetention({ now, env: Object.fromEntries(RETENTION_POLICIES.map((p) => [`RETENTION_${p.envKey}_DAYS`, "36500"])) });
    expect(res).toHaveLength(RETENTION_POLICIES.length);
    expect(res.every((r) => r.error === null)).toBe(true);
    await prisma.retentionRun.deleteMany({ where: { policy: { in: RETENTION_POLICIES.map((p) => p.name) }, startedAt: { gte: new Date(Date.now() - 60_000) } } });
  });
});

describe("runDueRetention", () => {
  it("staggers: at most maxPerTick due policies, skips ones that ran within ~23h or when disabled", async () => {
    await prisma.retentionRun.deleteMany({ where: { policy: { in: RETENTION_POLICIES.map((p) => p.name) } } });
    const env = Object.fromEntries(RETENTION_POLICIES.map((p) => [`RETENTION_${p.envKey}_DAYS`, "36500"]));
    expect(await runDueRetention({ now, env: { ...env, RETENTION_ENABLED: "false" } })).toEqual([]);
    const t = new Date();
    const first = await runDueRetention({ now: t, maxPerTick: 2, env });
    expect(first.map((r) => r.policy)).toEqual(RETENTION_POLICIES.slice(0, 2).map((p) => p.name));
    const second = await runDueRetention({ now: t, maxPerTick: 2, env });
    expect(second.map((r) => r.policy)).toEqual(RETENTION_POLICIES.slice(2, 4).map((p) => p.name));
    const dry = await runDueRetention({ now: t, maxPerTick: 1, env: { ...env, RETENTION_DRY_RUN: "true" } });
    expect(dry[0]).toMatchObject({ dryRun: true, policy: RETENTION_POLICIES[0]!.name });
    const later = await runDueRetention({ now: new Date(t.getTime() + 24 * 3_600_000), maxPerTick: 1, env });
    expect(later[0]!.policy).toBe(RETENTION_POLICIES[0]!.name);
    await prisma.retentionRun.deleteMany({ where: { policy: { startsWith: RETENTION_POLICIES[0]!.name } } });
    await prisma.retentionRun.deleteMany({ where: { policy: { in: RETENTION_POLICIES.map((p) => p.name) } } });
  });
});
