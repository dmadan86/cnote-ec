import { describe, expect, it } from "vitest";
import { specMatches } from "../src/heuristic/intent";

describe("heuristic regexes stay linear on hostile input", () => {
  it("specMatches handles long whitespace runs quickly", () => {
    const t = Date.now();
    specMatches(`gsm${" ".repeat(50_000)}x`);
    specMatches(`size${" ".repeat(50_000)}`);
    specMatches(`1${" ".repeat(50_000)}x`);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(specMatches("180 gsm paper, size: 12")).toEqual(expect.arrayContaining(["180 gsm"]));
  });
});
