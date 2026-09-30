import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { breaches, toMetricRow } from "../src/compute";
import { METRICS, getDefinition, meetsTarget } from "../src/definitions";
import { buildSql, withWindow } from "../src/sql";
import { addDays, assertDay, dateToDay, dayBounds, daysBetween, isMatured, istDay } from "../src/time";

const def = (id: string) => getDefinition(id)!;

describe("registry", () => {
  it("has unique ids, ADR refs, and consistent alert/target config", () => {
    expect(new Set(METRICS.map((m) => m.id)).size).toBe(METRICS.length);
    for (const m of METRICS) {
      expect(m.adr).toMatch(/^ADR-\d{3}$/);
      expect(m.formula.length).toBeGreaterThan(10);
      if (m.gate) expect(m.target).toBeDefined();
    }
    expect(METRICS.filter((m) => m.gate).length).toBeGreaterThanOrEqual(7);
  });
  it("alert rules match the ADR thresholds", () => {
    expect(def("auto_refund_rate").alert).toMatchObject({ direction: "above", threshold: 0.1 });
    expect(def("lead_to_conversation_rate").alert).toMatchObject({ direction: "below", threshold: 0.6 });
    expect(def("median_lead_response_minutes").alert).toMatchObject({ direction: "above", threshold: 120 });
  });
  it("meetsTarget both directions", () => {
    expect(meetsTarget({ value: 0.6, direction: "at_least" }, 0.6)).toBe(true);
    expect(meetsTarget({ value: 0.6, direction: "at_least" }, 0.59)).toBe(false);
    expect(meetsTarget({ value: 0.1, direction: "below" }, 0.1)).toBe(false);
    expect(meetsTarget({ value: 0.1, direction: "below" }, 0.09)).toBe(true);
  });
  it("every spec builds SQL with resolved window and typed params", () => {
    for (const m of METRICS) {
      const sql = withWindow(buildSql(m.spec), m.windowDays);
      expect(sql).not.toContain("__W__");
      expect(sql).toContain("$2::timestamptz");
    }
  });
});

describe("toMetricRow / breaches", () => {
  it("no divide-by-zero: empty denominators give no row", () => {
    expect(toMetricRow(def("auto_refund_rate"), { dim: "", num: 0, den: 0, val: null })).toBeNull();
    expect(toMetricRow(def("auto_refund_rate"), { dim: "", num: null, den: null, val: null })).toBeNull();
    expect(toMetricRow(def("median_lead_response_minutes"), { dim: "", num: null, den: 0, val: null })).toBeNull();
    expect(toMetricRow(def("median_lead_response_minutes"), { dim: "", num: null, den: 2, val: null })).toBeNull();
    expect(toMetricRow(def("orders_recorded"), { dim: "", num: 0, den: null, val: null })).toMatchObject({ value: 0 });
    expect(toMetricRow(def("leads_per_enquiry"), { dim: "", num: 3, den: 2, val: null })).toMatchObject({ value: 1.5 });
    expect(toMetricRow(def("auto_refund_rate"), { dim: "", num: Number.NaN, den: 1, val: null })).toBeNull();
  });
  it("rates stay within [0,1] whenever numerator <= denominator (property)", () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.nat(10_000), (a, b) => {
        const den = Math.max(a, b);
        const num = Math.min(a, b);
        for (const m of METRICS.filter((x) => x.kind === "rate")) {
          const r = toMetricRow(m, { dim: "", num, den, val: null });
          if (den === 0) expect(r).toBeNull();
          else {
            expect(r!.value).toBeGreaterThanOrEqual(0);
            expect(r!.value).toBeLessThanOrEqual(1);
          }
        }
      }),
    );
  });
  it("breaches respects direction, threshold strictness and sample size", () => {
    const refund = def("auto_refund_rate");
    const row = (value: number, denominator: number) => ({ dimension: "", value, numerator: value * denominator, denominator });
    expect(breaches(refund, row(0.11, 20))).toBe(true);
    expect(breaches(refund, row(0.1, 20))).toBe(false);
    expect(breaches(refund, row(0.5, 19))).toBe(false);
    expect(breaches(refund, undefined)).toBe(false);
    expect(breaches(def("lead_to_conversation_rate"), row(0.59, 20))).toBe(true);
    expect(breaches(def("lead_to_conversation_rate"), row(0.6, 20))).toBe(false);
    expect(breaches(def("orders_recorded"), row(5, 20))).toBe(false); // no rule
    expect(breaches(def("median_lead_response_minutes"), { dimension: "", value: 130, numerator: null, denominator: 5 })).toBe(true);
    expect(breaches(def("median_lead_response_minutes"), { dimension: "", value: 130, numerator: null, denominator: null })).toBe(false);
  });
});

describe("time", () => {
  it("IST day boundaries", () => {
    const { start, end } = dayBounds("2001-01-10");
    expect(start.toISOString()).toBe("2001-01-09T18:30:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
    expect(istDay(new Date("2001-01-09T18:29:59Z"))).toBe("2001-01-09");
    expect(istDay(new Date("2001-01-09T18:30:00Z"))).toBe("2001-01-10");
    expect(dateToDay(new Date("2001-01-10T00:00:00Z"))).toBe("2001-01-10");
  });
  it("addDays, daysBetween, validation, maturity", () => {
    expect(addDays("2001-02-28", 1)).toBe("2001-03-01");
    expect(daysBetween("2001-01-30", "2001-02-02")).toEqual(["2001-01-30", "2001-01-31", "2001-02-01", "2001-02-02"]);
    expect(daysBetween("2001-01-02", "2001-01-01")).toEqual([]);
    expect(() => assertDay("2001-02-30")).toThrow(/Invalid day/);
    expect(() => assertDay("bad")).toThrow(/Invalid day/);
    expect(isMatured("2001-01-10", 7, new Date("2001-01-17T18:29:59Z"))).toBe(false);
    expect(isMatured("2001-01-10", 7, new Date("2001-01-17T18:30:00Z"))).toBe(true);
  });
});
