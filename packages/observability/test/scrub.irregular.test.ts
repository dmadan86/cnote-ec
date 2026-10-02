import { describe, expect, it } from "vitest";
import { scrubString } from "../src";

describe("scrubString irregular phone formats and bounds", () => {
  for (const p of ["+91 - 98 765 - 43 210", "9 8 7 6 5 4 3 2 1 0", "(011) 2345 6789", "011-23456789", "+91 11 23456789"]) {
    it(`masks ${p}`, () => {
      expect(scrubString(`failed for ${p} today`).replace(/\D/g, "")).toBe("");
    });
  }
  it("masks the +91 0 trunk form and leaves non-phone digit runs alone", () => {
    expect(scrubString("call +91 0 98765 43210 now").replace(/\D/g, "")).toBe("");
    expect(scrubString("sku 12 345 678")).toBe("sku 12 345 678");
    expect(scrubString("1 2 3 4 5 6 7 8 9 0 1 2 3 4")).toBe("1 2 3 4 5 6 7 8 9 0 1 2 3 4");
  });
  it("truncates huge strings before matching", () => {
    expect(scrubString("x".repeat(100_000)).length).toBeLessThan(20_100);
  });
});
