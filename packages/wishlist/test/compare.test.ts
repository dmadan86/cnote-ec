import { describe, expect, it } from "vitest";
import { addToCompare, COMPARE_MAX, parseCompareIds, serializeCompareIds } from "../src";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("compare cookie", () => {
  it("keeps valid uuids, dedupes, lowercases", () => {
    expect(parseCompareIds(`${id(1)},${id(1)},${id(2).toUpperCase()}`)).toEqual([id(1), id(2)]);
  });
  it("drops garbage and caps at 4", () => {
    expect(parseCompareIds(`nope,${id(1)},'; drop,${id(2)},${id(3)},${id(4)},${id(5)}`)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(COMPARE_MAX).toBe(4);
  });
  it("handles empty, null and url-encoded input", () => {
    expect(parseCompareIds(undefined)).toEqual([]);
    expect(parseCompareIds("")).toEqual([]);
    expect(parseCompareIds(encodeURIComponent(`${id(1)},${id(2)}`))).toEqual([id(1), id(2)]);
    expect(parseCompareIds("%E0%A4%A")).toEqual([]);
    expect(serializeCompareIds([id(1), "x", id(1)])).toBe(id(1));
  });
  it("adds, ignores duplicates, enforces cap and category", () => {
    expect(addToCompare([], id(1), "c1", null)).toEqual({ status: "added", ids: [id(1)] });
    expect(addToCompare([id(1)], id(1), "c1", "c1").status).toBe("already");
    expect(addToCompare([id(1)], id(2), "c2", "c1").status).toBe("category_mismatch");
    expect(addToCompare([id(1), id(2), id(3), id(4)], id(5), "c1", "c1").status).toBe("full");
    expect(addToCompare([id(1)], id(2), "c1", "c1")).toEqual({ status: "added", ids: [id(1), id(2)] });
  });
});
