import { beforeEach, describe, expect, it, vi } from "vitest";

const computeDay = vi.fn(async () => ({ day: "", metrics: 0, rows: 0, alerts: 0 }));
vi.mock("../src/compute", () => ({ computeDay: (...a: unknown[]) => computeDay(...(a as [])), backfill: vi.fn(async () => [{ day: "2001-01-01", metrics: 1, rows: 3, alerts: 0 }]) }));

import { run } from "../src/cli";
import { NIGHTLY_LOOKBACK_DAYS, maybeNightly, nightly, refreshRecent, resetNightlyMarker, worker } from "../src/jobs";

beforeEach(() => {
  computeDay.mockClear();
  resetNightlyMarker();
});

describe("worker jobs", () => {
  it("registers two scheduled jobs and no event handlers", () => {
    expect(worker.name).toBe("metrics");
    expect(worker.handlers).toEqual({});
    expect(worker.jobs.map((j) => [j.name, j.everyMs])).toEqual([["metrics.refresh-recent", 900_000], ["metrics.nightly", 1_200_000]]);
  });
  it("refreshRecent recomputes today and yesterday (IST)", async () => {
    await refreshRecent(new Date("2001-01-10T20:00:00Z")); // 2001-01-11 01:30 IST
    expect(computeDay.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["2001-01-11", "2001-01-10"]);
  });
  it("nightly recomputes the trailing lookback, excluding today", async () => {
    await nightly(new Date("2001-03-01T20:30:00Z")); // 2001-03-02 02:00 IST
    const days = computeDay.mock.calls.map((c) => (c as unknown[])[0]);
    expect(days).toHaveLength(NIGHTLY_LOOKBACK_DAYS);
    expect(days[0]).toBe("2001-03-01");
    expect(days.at(-1)).toBe("2001-01-30");
  });
  it("maybeNightly runs once, only in the 02:00 IST hour", async () => {
    expect(await maybeNightly(new Date("2001-03-01T19:00:00Z"))).toBe(false); // 00:30 IST
    expect(computeDay).not.toHaveBeenCalled();
    expect(await maybeNightly(new Date("2001-03-01T20:45:00Z"))).toBe(true); // 02:15 IST
    expect(await maybeNightly(new Date("2001-03-01T21:00:00Z"))).toBe(false); // same IST day: already ran
    expect(await maybeNightly(new Date("2001-03-02T20:45:00Z"))).toBe(true); // next day
    const job = worker.jobs[1]!;
    await job.run(); // real clock: does not throw
  });
  it("refresh job delegates to refreshRecent", async () => {
    await worker.jobs[0]!.run();
    expect(computeDay).toHaveBeenCalledTimes(2);
  });
});

describe("cli", () => {
  it("requires --from and logs a line per day", async () => {
    await expect(run([])).rejects.toThrow(/Usage/);
    const lines: string[] = [];
    const res = await run(["--from", "2001-01-01", "--to", "2001-01-01", "--metric", "auto_refund_rate"], (l) => lines.push(l));
    expect(res).toHaveLength(1);
    expect(lines).toEqual(["2001-01-01: 3 rows, 0 alerts"]);
    await run(["--from", "2001-01-01"], () => {});
  });
});
