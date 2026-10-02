import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildVerificationEvidence, maskGstin, namesMatch, type EvidenceInput } from "../src/evidence";

const D = (s: string) => new Date(s);
const base = (over: Partial<EvidenceInput["business"]> = {}): EvidenceInput["business"] => ({
  id: "b1", name: "Acme Packaging Pvt. Ltd.", legalName: null, tradeName: null, gstin: "27ABCDE1234F1Z5", udyam: "UDYAM-MH-01-0000001",
  verificationTier: 1, badgeActive: true, createdAt: D("2024-01-01T00:00:00Z"), ...over,
});
const get = (e: ReturnType<typeof buildVerificationEvidence>, k: string) => e.checks.find((c) => c.key === k)!;

describe("maskGstin", () => {
  it("keeps only the state code and the last 4 characters", () => {
    expect(maskGstin("27ABCDE1234F1Z5")).toBe("27•••••••••F1Z5");
  });
  it("never leaks the PAN part", () => {
    expect(maskGstin("27ABCDE1234F1Z5")).not.toContain("ABCDE");
    expect(maskGstin("27ABCDE1234F1Z5")).not.toContain("1234");
  });
  it("returns null for empty and fully masks malformed input", () => {
    expect(maskGstin(null)).toBeNull();
    expect(maskGstin("  ")).toBeNull();
    expect(maskGstin("SHORT")).toBe("•••••");
  });
});

describe("namesMatch", () => {
  it("ignores company suffixes, case and punctuation", () => {
    expect(namesMatch("ACME PACKAGING PRIVATE LIMITED", ["Acme Packaging Pvt. Ltd."])).toBe(true);
    expect(namesMatch("Acme Packaging LLP", ["acme packaging"])).toBe(true);
  });
  it("rejects different entities and empty names", () => {
    expect(namesMatch("Zenith Steel Ltd", ["Acme Packaging"])).toBe(false);
    expect(namesMatch(undefined, ["Acme"])).toBe(false);
    expect(namesMatch("Acme", [null, ""])).toBe(false);
  });
});

describe("buildVerificationEvidence", () => {
  it("lists only checks that actually passed, with their dates", () => {
    const e = buildVerificationEvidence({
      business: base(),
      phoneVerifiedAt: D("2024-01-02T00:00:00Z"),
      records: [
        { kind: "gstin", status: "passed", details: { legalName: "ACME PACKAGING PRIVATE LIMITED" }, createdAt: D("2024-02-01T00:00:00Z") },
        { kind: "udyam", status: "passed", details: {}, createdAt: D("2024-02-01T00:00:01Z") },
      ],
    });
    expect(get(e, "phone")).toMatchObject({ passed: true, at: "2024-01-02T00:00:00.000Z" });
    expect(get(e, "gstin")).toMatchObject({ passed: true, at: "2024-02-01T00:00:00.000Z" });
    expect(get(e, "gstin_name_match").passed).toBe(true);
    expect(get(e, "udyam").passed).toBe(true);
    expect(get(e, "documents")).toMatchObject({ passed: false, at: null });
    expect(get(e, "audit")).toMatchObject({ passed: false, at: null });
    expect(e.gstinMasked).toBe("27•••••••••F1Z5");
  });

  it("does not claim a name match when the GST legal name differs", () => {
    const e = buildVerificationEvidence({
      business: base({ name: "Totally Different Traders" }),
      phoneVerifiedAt: null,
      records: [{ kind: "gstin", status: "passed", details: { legalName: "ACME PACKAGING PRIVATE LIMITED" }, createdAt: D("2024-02-01T00:00:00Z") }],
    });
    expect(get(e, "gstin").passed).toBe(true);
    expect(get(e, "gstin_name_match")).toMatchObject({ passed: false, at: null });
  });

  it("uses the newest record per kind: an expired audit is no longer passed", () => {
    const e = buildVerificationEvidence({
      business: base({ verificationTier: 2 }),
      phoneVerifiedAt: null,
      records: [
        { kind: "audit", status: "passed", details: {}, createdAt: D("2024-03-01T00:00:00Z") },
        { kind: "audit", status: "failed", details: { expired: true }, createdAt: D("2025-03-01T00:00:00Z") },
      ],
    });
    expect(get(e, "audit")).toMatchObject({ passed: false, at: null });
  });

  it("needs both the document and the KYC record for the documents check, dated by the later one", () => {
    const only = buildVerificationEvidence({ business: base(), phoneVerifiedAt: null, records: [{ kind: "document", status: "passed", details: {}, createdAt: D("2024-05-01T00:00:00Z") }] });
    expect(get(only, "documents").passed).toBe(false);
    const both = buildVerificationEvidence({
      business: base(),
      phoneVerifiedAt: null,
      records: [
        { kind: "document", status: "passed", details: {}, createdAt: D("2024-05-01T00:00:00Z") },
        { kind: "video_kyc", status: "passed", details: {}, createdAt: D("2024-05-03T00:00:00Z") },
      ],
    });
    expect(get(both, "documents")).toMatchObject({ passed: true, at: "2024-05-03T00:00:00.000Z" });
  });

  it("a failed GSTIN attempt shows nothing and exposes no identifier", () => {
    const e = buildVerificationEvidence({ business: base({ gstin: null }), phoneVerifiedAt: null, records: [{ kind: "gstin", status: "failed", details: { gstin: "27ABCDE1234F1Z5" }, createdAt: D("2024-02-01T00:00:00Z") }] });
    expect(get(e, "gstin").passed).toBe(false);
    expect(e.gstinMasked).toBeNull();
    expect(JSON.stringify(e)).not.toContain("ABCDE");
  });

  it("never serialises raw identifiers or legal names", () => {
    const e = buildVerificationEvidence({
      business: base({ legalName: "ACME PACKAGING PRIVATE LIMITED" }),
      phoneVerifiedAt: D("2024-01-02T00:00:00Z"),
      records: [{ kind: "gstin", status: "passed", details: { legalName: "ACME PACKAGING PRIVATE LIMITED" }, createdAt: D("2024-02-01T00:00:00Z") }],
    });
    const json = JSON.stringify(e);
    expect(json).not.toContain("27ABCDE1234F1Z5");
    expect(json).not.toContain("UDYAM-MH");
    expect(json).not.toContain("PRIVATE LIMITED");
  });

  it("is derived from verification data only: no plan, payment or ad inputs exist (ADR-003)", () => {
    const src = readFileSync(new URL("../src/evidence.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/subscription|plan\b|payment|billing|adCampaign|walletEntry/i);
  });
});
