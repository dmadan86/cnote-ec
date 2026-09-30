import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "../src/lib/format";

// 2026-03-05T20:00:00Z is 2026-03-06 01:30 IST (crosses the date line, so it proves the zone).
const ISO = "2026-03-05T20:00:00Z";

describe("format", () => {
  it("defaults to en-IN in IST", () => {
    expect(formatDate(ISO)).toBe(formatDate(ISO, "en"));
    expect(formatDate(ISO)).toMatch(/6 Mar 2026/);
    expect(formatDateTime(ISO)).toMatch(/6 Mar 2026.*1:30\s?am/i);
  });
  it("localises month names for hi and bn but keeps Latin digits", () => {
    for (const l of ["hi", "bn"] as const) {
      const out = formatDateTime(ISO, l);
      expect(out).not.toBe(formatDateTime(ISO, "en"));
      expect(out).toMatch(/2026/);
      expect(out).toMatch(/\b6\b/);
      expect(out).not.toMatch(/[०-९০-৯]/);
    }
    expect(formatDate(ISO, "hi")).not.toMatch(/Mar/);
  });
  it("formats date-only without time", () => {
    expect(formatDate(ISO, "en")).not.toMatch(/:/);
  });
});
