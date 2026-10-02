import { describe, expect, it } from "vitest";
import { z } from "zod";
import { maskEmail } from "../src";
import { grievancePolicy, numFromEnv } from "../src/config";
import { isUuid, parse } from "../src/util";

describe("util + config", () => {
  it("masks emails", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("@x")).toBe("***");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
  });
  it("validates uuids", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuid("nope")).toBe(false);
  });
  it("parse throws DomainError(validation)", () => {
    expect(() => parse(z.object({ a: z.string() }), {})).toThrow();
    try {
      parse(z.object({ a: z.string() }), {});
    } catch (e) {
      expect(e).toMatchObject({ code: "validation", details: { field: "a" } });
    }
  });
  it("policy defaults and env overrides (invalid values fall back)", () => {
    expect(grievancePolicy({})).toEqual({ ackHours: 24, resolveDays: 15, perHourLimit: 5, rightsRequestDays: 90 });
    expect(grievancePolicy({ GRIEVANCE_ACK_HOURS: "12", GRIEVANCE_RESOLVE_DAYS: "30", GRIEVANCE_RATE_LIMIT_PER_HOUR: "x" })).toEqual({ ackHours: 12, resolveDays: 30, perHourLimit: 5, rightsRequestDays: 90 });
    expect(grievancePolicy({ GRIEVANCE_RIGHTS_REQUEST_DAYS: "45" }).rightsRequestDays).toBe(45);
    expect(numFromEnv("0", 7)).toBe(7);
    expect(numFromEnv("", 7)).toBe(7);
    expect(grievancePolicy().ackHours).toBe(24);
  });
});
