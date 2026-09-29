import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set() {}, delete() {} }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect() {} }));
vi.mock("@cnote/leadgen", () => ({}));
vi.mock("@cnote/identity", () => ({ getSession: async () => null, REALM_POLICY: {}, cookieNames: () => ({}), isRealm: () => true }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));

describe("verifyOtp", () => {
  it("requires the matching consent before touching anything", async () => {
    const { verifyOtp } = await import("../src/otp");
    const r = await verifyOtp("cap", "9876543210", "123456", { matching: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors?.consent_matching).toBeTruthy();
  });
});
