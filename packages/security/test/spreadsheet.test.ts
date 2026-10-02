import { describe, expect, it } from "vitest";
import { FORMULA_START, neutraliseFormula, restoreNeutralised } from "../src";

describe("spreadsheet formula neutralisation", () => {
  it("quotes text cells that start with = + - @ tab or CR, and nothing else", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(neutraliseFormula(v)).toBe(`'${v}`);
    for (const v of ["plain", "a=b", "", "'quoted"]) expect(neutraliseFormula(v)).toBe(v);
    expect(FORMULA_START.test("=x")).toBe(true);
  });
  it("leaves numbers, null and undefined untouched (a negative number is not an attack)", () => {
    expect(neutraliseFormula(-5)).toBe(-5);
    expect(neutraliseFormula(null)).toBeNull();
    expect(neutraliseFormula(undefined)).toBeUndefined();
  });
  it("restoreNeutralised is the inverse for our own exports only", () => {
    expect(restoreNeutralised("'=1+1")).toBe("=1+1");
    expect(restoreNeutralised("'-x")).toBe("-x");
    expect(restoreNeutralised("'hello")).toBe("'hello");
    expect(restoreNeutralised("'")).toBe("'");
    expect(restoreNeutralised("plain")).toBe("plain");
  });
});
