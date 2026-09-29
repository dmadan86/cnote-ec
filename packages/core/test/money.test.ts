import { describe, expect, it } from "vitest";
import { formatINR, rupeesToPaise } from "../src/money";

describe("money", () => {
  it("converts rupees to integer paise", () => {
    expect(rupeesToPaise(5.2)).toBe(520);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
  });
  it("formats INR in Indian grouping", () => {
    expect(formatINR(199900)).toBe("₹1,999");
    expect(formatINR(520)).toBe("₹5.20");
    expect(formatINR(1000000000)).toBe("₹1,00,00,000");
  });
});
