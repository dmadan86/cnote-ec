import { describe, expect, it } from "vitest";
import { capRows, EXPORT_ROW_CAP, EXPORT_TAKE, exportCollection } from "../src";

describe("personal export helpers (DPDP access right, security audit M10)", () => {
  it("fetches one extra row so a cut collection can be flagged", () => {
    expect(EXPORT_TAKE).toBe(EXPORT_ROW_CAP + 1);
  });
  it("passes small collections through untouched", () => {
    expect(capRows([1, 2, 3])).toEqual({ rows: [1, 2, 3], truncated: false });
    expect(exportCollection([])).toEqual({ items: [], truncated: false });
    expect(exportCollection(Array.from({ length: EXPORT_ROW_CAP }, (_, i) => i)).truncated).toBe(false);
  });
  it("caps oversized collections and says so", () => {
    const rows = Array.from({ length: EXPORT_TAKE }, (_, i) => i);
    const out = exportCollection(rows);
    expect(out.truncated).toBe(true);
    expect(out.items).toHaveLength(EXPORT_ROW_CAP);
    expect(out.items[0]).toBe(0);
  });
});
