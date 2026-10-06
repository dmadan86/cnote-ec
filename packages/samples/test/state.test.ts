import { describe, expect, it } from "vitest";
import { sampleConfig, samplesEnabled } from "../src/config";
import { FINAL_STATUSES, OPEN_STATUSES, TRANSITIONS, activeKeyFor, approvalRate, assertTransition, canTransition, isOpen, type SampleStatus } from "../src/state";

describe("sample state machine", () => {
  it("walks the happy path and nothing else", () => {
    const path: SampleStatus[] = ["requested", "accepted", "dispatched", "delivered", "approved"];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    expect(canTransition("requested", "dispatched")).toBe(false);
    expect(canTransition("accepted", "delivered")).toBe(false);
    expect(canTransition("delivered", "accepted")).toBe(false);
    expect(canTransition("dispatched", "cancelled")).toBe(false); // cannot cancel once it is on its way
  });

  it("final statuses are terminal and open + final cover every status", () => {
    for (const s of FINAL_STATUSES) expect(TRANSITIONS[s]).toEqual([]);
    expect([...OPEN_STATUSES, ...FINAL_STATUSES].sort()).toEqual(Object.keys(TRANSITIONS).sort());
    expect(isOpen("delivered")).toBe(true);
    expect(isOpen("approved")).toBe(false);
  });

  it("assertTransition throws a stable conflict", () => {
    expect(() => assertTransition("approved", "rejected")).toThrowError(/not available for a request in its current status/);
    expect(() => assertTransition("requested", "accepted")).not.toThrow();
  });

  it("approval rate is withheld below the minimum sample size", () => {
    expect(approvalRate(4, 4, 5)).toBeNull();
    expect(approvalRate(0, 0, 5)).toBeNull();
    expect(approvalRate(4, 5, 5)).toBeCloseTo(0.8);
    expect(approvalRate(0, 7, 5)).toBe(0);
  });

  it("the duplicate key separates products and conversations", () => {
    expect(activeKeyFor("b", { listingId: "l1" })).not.toBe(activeKeyFor("b", { listingId: "l2" }));
    expect(activeKeyFor("b", { listingId: "l1" })).not.toBe(activeKeyFor("b", { matchId: "l1" }));
    expect(activeKeyFor("b", { matchId: "m" })).toBe("b:m:m");
  });
});

describe("config", () => {
  it("defaults: 48h SLA, flag off", () => {
    const keep = { ...process.env };
    delete process.env.SAMPLES_ENABLED; delete process.env.SAMPLES_RESPONSE_HOURS; delete process.env.SAMPLES_MAX_OPEN_PER_BUYER;
    expect(samplesEnabled()).toBe(false);
    expect(sampleConfig()).toMatchObject({ responseHours: 48, maxOpenPerBuyer: 5, requestsPerDay: 10, minEvaluatedForRate: 5 });
    process.env.SAMPLES_ENABLED = "true"; process.env.SAMPLES_RESPONSE_HOURS = "12"; process.env.SAMPLES_MAX_OPEN_PER_BUYER = "0"; // 0 is below the minimum: default
    expect(samplesEnabled()).toBe(true);
    expect(sampleConfig()).toMatchObject({ responseHours: 12, maxOpenPerBuyer: 5 });
    process.env.SAMPLES_RESPONSE_HOURS = "abc";
    expect(sampleConfig().responseHours).toBe(48);
    Object.assign(process.env, keep);
    if (keep.SAMPLES_ENABLED === undefined) delete process.env.SAMPLES_ENABLED;
    if (keep.SAMPLES_RESPONSE_HOURS === undefined) delete process.env.SAMPLES_RESPONSE_HOURS;
    if (keep.SAMPLES_MAX_OPEN_PER_BUYER === undefined) delete process.env.SAMPLES_MAX_OPEN_PER_BUYER;
  });
});
