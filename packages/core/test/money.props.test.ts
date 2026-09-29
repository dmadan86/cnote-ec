import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatINR, paiseToNumber, rupeesToPaise } from "../src/money";

const opts = { seed: 42, numRuns: 300 };

describe("money (properties)", () => {
  it("rupeesToPaise always yields an integer", () => {
    fc.assert(fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (r) => Number.isInteger(rupeesToPaise(r))), opts);
  });

  it("whole paise round-trip: rupeesToPaise(p / 100) === p", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100_000_000_000 }), (p) => rupeesToPaise(p / 100) === p), opts);
  });

  it("two-decimal rupee strings convert exactly (no float drift)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 99 }), (r, ps) => {
        expect(rupeesToPaise(Number(`${r}.${String(ps).padStart(2, "0")}`))).toBe(r * 100 + ps);
      }),
      opts,
    );
  });

  it("is monotonic non-decreasing", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), fc.double({ min: 0, max: 1e7, noNaN: true }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return rupeesToPaise(lo) <= rupeesToPaise(hi);
      }),
      opts,
    );
  });

  it("formatINR: digits parse back to the amount, prefix is the rupee sign", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000_000 }), (p) => {
        const s = formatINR(p);
        expect(s.startsWith("₹")).toBe(true);
        expect(Math.round(Number(s.slice(1).replace(/,/g, "")) * 100)).toBe(p);
      }),
      opts,
    );
  });

  it("formatINR: whole rupees never show .00; fractional always show two decimals", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000_000 }), (p) => {
        const s = formatINR(p);
        if (p % 100 === 0) expect(s).not.toContain(".");
        else expect(s).toMatch(/\.\d{2}$/);
      }),
      opts,
    );
  });

  it("formatINR uses Indian grouping: last group of 3, then groups of 2", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000_000 }), (p) => {
        const whole = formatINR(p * 100).slice(1).split(",");
        expect(whole[whole.length - 1]).toMatch(/^\d{1,3}$/);
        if (whole.length > 1) {
          expect(whole[whole.length - 1]).toHaveLength(3);
          for (const g of whole.slice(1, -1)) expect(g).toHaveLength(2);
          expect(whole[0]).toMatch(/^\d{1,2}$/);
        }
      }),
      opts,
    );
  });

  it("formatINR accepts bigint identically to number", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 40 }), (p) => formatINR(BigInt(p)) === formatINR(p)), opts);
  });
});

describe("money (examples)", () => {
  it("boundaries", () => {
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(1)).toBe("₹0.01");
    expect(formatINR(99)).toBe("₹0.99");
    expect(formatINR(100)).toBe("₹1");
    expect(formatINR(99_999_900)).toBe("₹9,99,999");
    expect(formatINR(10_000_000)).toBe("₹1,00,000");
    expect(formatINR(1_234_567_89)).toBe("₹12,34,567.89");
  });
  it("negative amounts keep the sign and drop .00", () => {
    expect(formatINR(-199900)).toContain("1,999");
    expect(formatINR(-199900)).toContain("-");
    expect(formatINR(-199900)).not.toContain(".00");
  });
  it("rupeesToPaise classic float traps", () => {
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise(-5.2)).toBe(-520);
  });
  it("paiseToNumber maps null/undefined to null and bigint/number to number", () => {
    expect(paiseToNumber(null)).toBeNull();
    expect(paiseToNumber(undefined)).toBeNull();
    expect(paiseToNumber(123n)).toBe(123);
    expect(paiseToNumber(0)).toBe(0);
  });
});
