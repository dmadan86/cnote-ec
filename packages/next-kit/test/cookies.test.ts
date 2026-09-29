import { describe, expect, it } from "vitest";
import { jwtExp, safeNext } from "../src/cookies";

describe("safeNext", () => {
  it("allows same-origin relative paths", () => {
    expect(safeNext("/account?tab=1")).toBe("/account?tab=1");
    expect(safeNext("/")).toBe("/");
  });
  it.each(["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "evil", "/a\nb", "", null, undefined])("rejects %s", (v) => {
    expect(safeNext(v as string | null)).toBe("/");
  });
  it("uses the fallback", () => expect(safeNext("//x", "/home")).toBe("/home"));
});

describe("jwtExp", () => {
  it("decodes exp without verifying", () => {
    const body = Buffer.from(JSON.stringify({ exp: 123 })).toString("base64url");
    expect(jwtExp(`h.${body}.s`)).toBe(123);
    expect(jwtExp("garbage")).toBeNull();
    expect(jwtExp(undefined)).toBeNull();
  });
});
