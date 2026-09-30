import { describe, expect, it } from "vitest";
import { DomainError, HTTP_STATUS, type ErrorCode } from "../src/errors";

describe("DomainError", () => {
  it("is an Error with code, message, details and a stable name", () => {
    const e = new DomainError("conflict", "dup", { field: "x" });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(DomainError);
    expect(e.name).toBe("DomainError");
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("dup");
    expect(e.details).toEqual({ field: "x" });
    expect(e.stack).toBeTruthy();
  });
  it("details are optional", () => {
    expect(new DomainError("not_found", "nope").details).toBeUndefined();
  });
  it("carries an optional stable message key (4th argument) without affecting other fields", () => {
    const e = new DomainError("insufficient_credits", "Not enough lead credits.", undefined, "credits.insufficient");
    expect(e.key).toBe("credits.insufficient");
    expect(e.details).toBeUndefined();
    expect(new DomainError("conflict", "dup", { a: 1 }).key).toBeUndefined();
  });
  it("maps every code to a distinct 4xx HTTP status", () => {
    const codes = Object.keys(HTTP_STATUS) as ErrorCode[];
    expect(codes).toHaveLength(7);
    for (const c of codes) {
      expect(HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
      expect(HTTP_STATUS[c]).toBeLessThan(500);
    }
    expect(new Set(Object.values(HTTP_STATUS)).size).toBe(codes.length);
    expect(HTTP_STATUS.unauthenticated).toBe(401);
    expect(HTTP_STATUS.forbidden).toBe(403);
    expect(HTTP_STATUS.rate_limited).toBe(429);
  });
});
