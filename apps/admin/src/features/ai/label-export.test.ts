import type { OpsLabelRow } from "@cnote/ai";
import { describe, expect, it } from "vitest";
import { LABEL_CSV_HEADER, labelCsvRow, labelJsonl, parseLabelFilters } from "./label-export";

const row = (over: Partial<OpsLabelRow> = {}): OpsLabelRow => ({
  decisionId: "d1", capability: "moderate", subjectType: "listing", label: "rejected", labelledOn: "2026-10-01", labellerRoles: ["ops_moderator"], provider: "anthropic",
  modelId: "claude-x", promptVersion: "moderate-v1", confidence: 0.4, queueReason: "Low confidence", inputRedacted: { text: "boxes" }, output: { verdict: "review" }, ...over,
});

describe("parseLabelFilters", () => {
  it("turns IST days into [from, next midnight), defaults to jsonl, accepts csv", () => {
    const r = parseLabelFilters({ from: "2026-10-01", to: "2026-10-02", capability: "moderate", format: "csv" });
    expect(r.problem).toBeNull();
    expect(r.format).toBe("csv");
    expect(r.filters.from?.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(r.filters.to?.toISOString()).toBe("2026-10-02T18:30:00.000Z");
    expect(r.filters.capability).toBe("moderate");
    expect(parseLabelFilters({}).format).toBe("jsonl");
  });
  it("rejects bad dates, ranges, capabilities and formats", () => {
    for (const bad of [{ from: "x" }, { to: "2026-13-45" }, { from: "2026-10-05", to: "2026-10-01" }, { capability: "nope" }, { format: "xlsx" }]) {
      expect(parseLabelFilters(bad).problem, JSON.stringify(bad)).toEqual(expect.any(String));
    }
  });
});

describe("serialisation", () => {
  it("JSONL is one JSON object per line with no person or subject ids", () => {
    const line = labelJsonl(row());
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ decisionId: "d1", labellerRoles: ["ops_moderator"] });
    expect(Object.keys(JSON.parse(line))).not.toEqual(expect.arrayContaining(["subjectId", "resolvedBy"]));
  });
  it("CSV neutralises formulas in every text cell, quotes separators and matches the header width", () => {
    const csv = labelCsvRow(row({ queueReason: "=HYPERLINK(\"http://x\")", modelId: "+cmd", promptVersion: "@SUM(1)", inputRedacted: { text: "a,b\nc" } }));
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'@SUM(1)");
    expect(csv).toContain('"{""text"":""a,b\\nc""}"');
    const cells = csv.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.filter((c, i, a) => i < a.length - 1 || c !== "");
    expect(cells.length).toBe(LABEL_CSV_HEADER.length);
  });
});
