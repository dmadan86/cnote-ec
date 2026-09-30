import { describe, expect, it } from "vitest";
import { formatTarget, formatValue, parseRange, sparklinePoints } from "./format";

describe("metrics formatting", () => {
  it("formats by unit and tolerates missing values", () => {
    expect(formatValue("ratio", 0.1234)).toBe("12.3%");
    expect(formatValue("minutes", 15)).toBe("15.0 min");
    expect(formatValue("per_enquiry", 1.5)).toBe("1.50");
    expect(formatValue("count", 3.4)).toBe("3");
    expect(formatValue("ratio", null)).toBe("—");
    expect(formatValue("ratio", Number.NaN)).toBe("—");
    expect(formatTarget("ratio", { value: 0.6, direction: "at_least" })).toBe("≥ 60.0%");
    expect(formatTarget("ratio", { value: 0.1, direction: "below" })).toBe("< 10.0%");
    expect(formatTarget("ratio", null)).toBe("—");
  });
  it("builds sparkline points inside the box", () => {
    expect(sparklinePoints([], 100, 20)).toBe("");
    expect(sparklinePoints([5], 100, 20)).toBe("50.0,10.0");
    expect(sparklinePoints([1, 1], 100, 20)).toBe("2.0,10.0 98.0,10.0");
    expect(sparklinePoints([0, 1], 100, 20)).toBe("2.0,18.0 98.0,2.0");
  });
  it("parses the range filter", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange("90")).toBe(90);
    expect(parseRange("5")).toBe(28);
    expect(parseRange(undefined)).toBe(28);
  });
});
