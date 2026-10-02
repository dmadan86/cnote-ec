import { describe, expect, it } from "vitest";
import { toSellerSummary } from "../src/seller";

describe("toSellerSummary", () => {
  it("returns a zero-count summary with no groups (no average to show)", () => {
    expect(toSellerSummary("s", [])).toEqual({ sellerBusinessId: "s", count: 0, average: 0, histogram: [0, 0, 0, 0, 0] });
  });
  it("aggregates the histogram and rounds the average to one decimal", () => {
    const s = toSellerSummary("s", [{ rating: 5, count: 2 }, { rating: 4, count: 1 }]);
    expect(s).toMatchObject({ count: 3, average: 4.7, histogram: [0, 0, 0, 1, 2] });
  });
  it("ignores out-of-range ratings", () => {
    expect(toSellerSummary("s", [{ rating: 9, count: 5 }, { rating: 0, count: 1 }]).count).toBe(0);
  });
});
