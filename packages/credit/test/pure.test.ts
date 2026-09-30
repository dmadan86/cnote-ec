import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assessEligibility, maxAmount } from "../src/eligibility";
import { allInAprBps, buildKfs, interestPaise, totalRepayablePaise } from "../src/kfs";
import { MOCK_LENDER } from "../src/partner";
import { attachedShare, computeGnpa, fldgFor } from "../src/stats";
import { bucketOf, dpdOf } from "../src/loans";
import { buildPartnerRequest, minimalFeatures } from "../src/applications";
import { EMPTY_FEATURES, type Band } from "../src/model";
import { facts } from "./helpers";

const T = { principalPaise: 10_000_000, aprBps: 2400, tenorDays: 30, processingFeePaise: 100_000, otherFeesPaise: 0 };

describe("kfs arithmetic", () => {
  it("interest is simple act/365 and the total adds fees", () => {
    expect(interestPaise(10_000_000, 1000, 365)).toBe(1_000_000);
    expect(interestPaise(10_000_000, 2400, 30)).toBe(197_260);
    expect(totalRepayablePaise(T)).toBe(10_000_000 + 197_260 + 100_000);
    expect(allInAprBps({ ...T, principalPaise: 0 })).toBe(0);
  });
  it("all-in APR: CI counterexample (small principal, short tenor) still discloses at least the contract rate", () => {
    expect(allInAprBps({ principalPaise: 100_000, aprBps: 559, tenorDays: 7, processingFeePaise: 0, otherFeesPaise: 0 })).toBeGreaterThanOrEqual(559);
  });
  it("all-in APR is never below the contractual APR and total >= principal", () => {
    fc.assert(fc.property(fc.integer({ min: 100_000, max: 900_000_000 }), fc.integer({ min: 0, max: 4800 }), fc.integer({ min: 7, max: 120 }), fc.integer({ min: 0, max: 50_000 }), (p, apr, tenor, fee) => {
      const t = { principalPaise: p, aprBps: apr, tenorDays: tenor, processingFeePaise: fee, otherFeesPaise: 0 };
      expect(totalRepayablePaise(t)).toBeGreaterThanOrEqual(p);
      expect(allInAprBps(t)).toBeGreaterThanOrEqual(apr); // never understates the contract rate, whatever the rounding
    }));
  });
  it("buildKfs discloses lender, fees, cooling-off, grievance officer", () => {
    const k = buildKfs("invoice_financing", T, MOCK_LENDER, { CREDIT_COOLING_OFF_DAYS: "5", CREDIT_LATE_FEE_BPS_PER_MONTH: "300" });
    expect(k).toMatchObject({ version: "kfs-v1", lenderName: MOCK_LENDER.name, coolingOffDays: 5, lateFeeBpsPerMonth: 300, repayment: "escrow_release", processingFeePaise: 100_000 });
    expect(k.grievanceOfficer.email).toContain("@");
    expect(buildKfs("bnpl", T, MOCK_LENDER).repayment).toBe("buyer_instalment");
  });
});

const good = { gstVerified: true, gstActive: true };
const base = (o: Partial<Parameters<typeof assessEligibility>[0]> = {}) => {
  const e = facts({ status: "funded", amountPaise: 10_000_000 });
  return assessEligibility({ product: "invoice_financing", businessId: e.sellerBusinessId, escrow: e, score: { score: 700, band: "very_good" }, features: good, sellerNetPaise: 9_700_000, ...o });
};

describe("eligibility", () => {
  it("passes a funded, unfrozen escrow for a verified seller and caps at the band advance rate", () => {
    const r = base();
    expect(r).toMatchObject({ eligible: true, reasons: [], maxAmountPaise: 7_760_000 });
  });
  it("each rule blocks", () => {
    const e = facts({ status: "funded" });
    const seller = e.sellerBusinessId;
    expect(base({ features: { gstVerified: false, gstActive: false } }).reasons).toContain("gst_not_verified");
    expect(base({ features: { gstVerified: true, gstActive: false } }).reasons).toContain("gst_inactive");
    expect(base({ score: { score: 499, band: "poor" } }).reasons).toEqual(expect.arrayContaining(["score_too_low", "amount_too_small"]));
    expect(base({ escrow: { ...e, frozen: true }, businessId: seller }).reasons).toContain("escrow_frozen");
    expect(base({ escrow: { ...e, status: "awaiting_funding" }, businessId: seller }).reasons).toContain("escrow_not_funded");
    expect(base({ businessId: "someone-else" })).toMatchObject({ eligible: false, maxAmountPaise: 0 });
    expect(base({ requestedAmountPaise: 1 }).reasons).toContain("amount_too_small");
    expect(base({ requestedAmountPaise: 99_999_999 }).reasons).toContain("amount_exceeds_limit");
  });
  it("BNPL is for the buyer of an unfunded escrow with the higher score floor", () => {
    const e = facts({ status: "awaiting_funding" });
    const mk = (o: object = {}) => assessEligibility({ product: "bnpl", businessId: e.buyerBusinessId, escrow: e, score: { score: 560, band: "fair" }, features: good, sellerNetPaise: 0, ...o });
    expect(mk()).toMatchObject({ eligible: true, maxAmountPaise: 10_000_000 });
    expect(mk({ score: { score: 540, band: "fair" } }).reasons).toContain("score_too_low");
    expect(mk({ escrow: { ...e, status: "funded" } }).reasons).toContain("escrow_already_funded");
    expect(mk({ escrow: { ...e, status: "released" } }).reasons).toContain("escrow_closed");
    expect(mk({ businessId: e.sellerBusinessId }).reasons).toContain("not_your_order");
  });
  it("max amount is monotone in band", () => {
    const bands: Band[] = ["poor", "fair", "good", "very_good", "excellent"];
    fc.assert(fc.property(fc.integer({ min: 100_000, max: 900_000_000 }), (amt) => {
      for (const product of ["invoice_financing", "bnpl"] as const) {
        const ms = bands.map((b) => maxAmount(product, b, { amountPaise: amt }, Math.floor(amt * 0.97)));
        for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]!);
        expect(ms[0]).toBe(0);
      }
    }));
  });
});

describe("loan book maths", () => {
  it("dpd and buckets", () => {
    const due = new Date("2026-01-10T00:00:00Z");
    expect(dpdOf(due, new Date("2026-01-09T00:00:00Z"))).toBe(0);
    expect(dpdOf(due, new Date("2026-01-11T00:00:00Z"))).toBe(1);
    expect([0, 1, 29, 30, 59, 60, 89, 90, 400].map(bucketOf)).toEqual([0, 1, 1, 30, 30, 60, 60, 90, 90]);
  });
  it("GNPA: >=90 DPD outstanding + write-offs over open book; repaid excluded; write-offs never help", () => {
    expect(computeGnpa([])).toEqual({ gnpaRatio: 0, gnpaPaise: 0, bookPaise: 0 });
    const loans = [
      { outstandingPaise: 9_000, dpd: 0, status: "active", writtenOffPaise: 0 },
      { outstandingPaise: 1_000, dpd: 95, status: "overdue", writtenOffPaise: 0 },
      { outstandingPaise: 0, dpd: 0, status: "repaid", writtenOffPaise: 0 },
    ];
    expect(computeGnpa(loans)).toEqual({ gnpaRatio: 0.1, gnpaPaise: 1_000, bookPaise: 10_000 });
    const withWo = computeGnpa([...loans, { outstandingPaise: 0, dpd: 120, status: "written_off", writtenOffPaise: 500 }]);
    expect(withWo.gnpaPaise).toBe(1_500);
    expect(withWo.gnpaRatio).toBeGreaterThan(0.1);
  });
  it("GNPA ratio is in 0..1", () => {
    fc.assert(fc.property(fc.array(fc.record({ outstandingPaise: fc.nat(1e9), dpd: fc.nat(400), status: fc.constantFrom("active", "overdue", "repaid", "written_off"), writtenOffPaise: fc.nat(1e9) })), (ls) => {
      const g = computeGnpa(ls);
      expect(g.gnpaRatio).toBeGreaterThanOrEqual(0);
      expect(g.gnpaRatio).toBeLessThanOrEqual(1);
    }));
  });
  it("attached share and FLDG", () => {
    expect(attachedShare(1, 0)).toBe(0);
    expect(attachedShare(150, 1000)).toBe(0.15);
    expect(attachedShare(5000, 1000)).toBe(1);
    expect(fldgFor("p", 500, 1_000_000, 20_000)).toMatchObject({ capPaise: 50_000, exposurePaise: 20_000, headroomPaise: 30_000, utilisation: 0.4 });
    expect(fldgFor("p", 500, 1_000_000, 90_000)).toMatchObject({ exposurePaise: 50_000, headroomPaise: 0, utilisation: 1 });
    expect(fldgFor("p", 500, 0, 0).utilisation).toBe(0);
    fc.assert(fc.property(fc.nat(1e10), fc.nat(1e10), fc.integer({ min: 0, max: 10_000 }), (o, d, bps) => {
      const f = fldgFor("p", bps, o, d);
      expect(f.exposurePaise).toBeLessThanOrEqual(f.capPaise);
      expect(f.exposurePaise).toBeLessThanOrEqual(d);
      expect(f.headroomPaise).toBeGreaterThanOrEqual(0);
    }));
  });
});

describe("data minimisation", () => {
  it("partner payload carries only whitelisted features + score, never GSTIN or raw returns", () => {
    const f = { ...EMPTY_FEATURES, gstVerified: true, gstActive: true, gstFilingsTotal: 6, gstFilingsFiled: 5, escrowCompleted: 4, escrowClean: 3 };
    const m = minimalFeatures(f);
    expect(m.gstFilingsFiledRatio).toBe(0.83);
    expect(m.escrowCleanRatio).toBe(0.75);
    expect(minimalFeatures(EMPTY_FEATURES)).toMatchObject({ gstFilingsFiledRatio: null, escrowCleanRatio: null });
    const req = buildPartnerRequest({ applicationId: "a", product: "bnpl", amountPaise: 1, tenorDays: 30, businessId: "b", escrowId: "e", orderId: "o", orderAmountPaise: 1 },
      { id: "s", businessId: "b", score: 700, band: "very_good", modelVersion: "credit-v1", computedAt: "", trigger: "t", reasons: [{ code: "TRUST_LOW", direction: "negative", points: 1, maxPoints: 80 }, { code: "GST_NOT_VERIFIED", direction: "positive", points: 60, maxPoints: 60 }] }, f);
    expect(req.score.reasonCodes).toEqual(["TRUST_LOW"]);
    const json = JSON.stringify(req);
    expect(json).not.toMatch(/gstin|filings"|email|phone|address/i);
  });
});
