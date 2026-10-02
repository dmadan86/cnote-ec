import { describe, expect, it } from "vitest";
import { csvCell, csvRow, CSV_HEADER, parseConsentFilters } from "./consent-filters";

describe("parseConsentFilters", () => {
  it("turns IST calendar days into [from, next midnight) instants", () => {
    const { filters, problem } = parseConsentFilters({ from: "2026-10-01", to: "2026-10-02", v: "1", action: "withdraw", q: " abc " });
    expect(problem).toBeNull();
    expect(filters.from?.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(filters.to?.toISOString()).toBe("2026-10-02T18:30:00.000Z");
    expect(filters).toMatchObject({ policyVersion: 1, action: "withdraw", q: "abc" });
  });
  it("rejects bad dates, ranges, versions and actions with a message", () => {
    for (const bad of [{ from: "yesterday" }, { to: "2026-13-45" }, { from: "2026-10-05", to: "2026-10-01" }, { v: "0" }, { v: "1.5" }, { action: "maybe" }]) {
      expect(parseConsentFilters(bad).problem, JSON.stringify(bad)).toEqual(expect.any(String));
    }
  });
  it("filters by app and rejects an unknown one", () => {
    expect(parseConsentFilters({ app: "seller" }).filters).toEqual({ app: "seller" });
    expect(parseConsentFilters({ app: "mobile" }).problem).toBe("Unknown app.");
  });
  it("accepts an empty filter set", () => expect(parseConsentFilters({})).toEqual({ filters: {}, problem: null }));
});

describe("CSV", () => {
  it("quotes separators and neutralises spreadsheet formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(null)).toBe("");
    expect(csvCell(false)).toBe("false");
  });
  it("writes one row per receipt matching the header", () => {
    const row = csvRow({ id: "r1", createdAt: "2026-10-01T00:00:00.000Z", clientAt: 1_790_000_000, consentId: "a".repeat(32), personId: null, app: "web", policyVersion: 1, registryHash: "f".repeat(64), action: "custom", analytics: true, marketing: false, functional: true, gpc: false, locale: "hi" });
    expect(row.split(",")).toHaveLength(CSV_HEADER.length);
    expect(row).toContain(",,");
  });
});
