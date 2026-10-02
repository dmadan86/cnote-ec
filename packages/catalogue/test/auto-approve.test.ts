import { describe, expect, it } from "vitest";
import { autoApprovePolicy, mayAutoApprove } from "../src/versions";

const now = new Date("2026-10-02T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const policy = autoApprovePolicy({} as NodeJS.ProcessEnv);
const trusted = { verificationTier: 2, trustScore: 80, createdAt: daysAgo(90) };
const clean = { outcome: "allow" as const, deterministic: "clean" };

describe("auto-approval policy (security audit H3)", () => {
  it("approves only deterministic-clean + model allow + aged account + staff-approved history", () => {
    expect(mayAutoApprove(clean, trusted, 5, now, policy)).toBe(true);
  });
  it("a model allow without a deterministic-clean result never auto-approves", () => {
    expect(mayAutoApprove({ outcome: "allow" }, trusted, 5, now, policy)).toBe(false);
    expect(mayAutoApprove({ outcome: "allow", deterministic: "review" }, trusted, 5, now, policy)).toBe(false);
    expect(mayAutoApprove({ outcome: "review", deterministic: "clean" }, trusted, 5, now, policy)).toBe(false);
  });
  it("tier 1 + trust 60 alone is not enough: needs account age and history", () => {
    const fresh = { verificationTier: 1, trustScore: 60, createdAt: daysAgo(1) };
    expect(mayAutoApprove(clean, fresh, 99, now, policy)).toBe(false); // too new
    expect(mayAutoApprove(clean, { ...fresh, createdAt: daysAgo(90) }, 0, now, policy)).toBe(false); // no history
    expect(mayAutoApprove(clean, { ...fresh, createdAt: undefined }, 99, now, policy)).toBe(false); // unknown age fails closed
    expect(mayAutoApprove(clean, { ...fresh, createdAt: daysAgo(90) }, 3, now, policy)).toBe(true);
  });
  it("thresholds and sample rate are configurable and clamped", () => {
    const p = autoApprovePolicy({ LISTING_AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS: "120", LISTING_AUTO_APPROVE_MIN_HUMAN_APPROVED: "10", LISTING_AUTO_APPROVE_SAMPLE_RATE: "7" } as unknown as NodeJS.ProcessEnv);
    expect(p).toMatchObject({ minAccountAgeDays: 120, minHumanApproved: 10, sampleRate: 1 });
    expect(mayAutoApprove(clean, trusted, 5, now, p)).toBe(false);
    expect(policy.sampleRate).toBe(0.05);
  });
});
