import { describe, expect, it } from "vitest";
import { FULFILMENT_STAGES, TRACKING_STEPS } from "@cnote/enquiry";
import bn from "../messages/bn.orderTracking.json";
import en from "../messages/en.orderTracking.json";
import gu from "../messages/gu.orderTracking.json";
import hi from "../messages/hi.orderTracking.json";
import kn from "../messages/kn.orderTracking.json";
import mr from "../messages/mr.orderTracking.json";
import ta from "../messages/ta.orderTracking.json";
import te from "../messages/te.orderTracking.json";

type Json = { [k: string]: Json | string };
const flat = (o: Json, p = ""): Record<string, string> => Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === "string" ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const ph = (m: string) => [...m.matchAll(/\{(\w+)/g)].map((x) => x[1]!).sort().join();

describe("orderTracking catalogue", () => {
  for (const [loc, cat] of Object.entries({ hi, kn, ta, te, mr, gu, bn })) {
    it(`${loc} has exactly the keys and placeholders of en, and is translated`, () => {
      const L = flat(cat as Json);
      expect(Object.keys(L).sort()).toEqual(Object.keys(E).sort());
      for (const k of Object.keys(E)) {
        expect(ph(L[k]!), k).toBe(ph(E[k]!));
        expect(L[k], k).not.toBe(E[k]);
      }
    });
  }
  it("has a label for every stage, step and state the timeline can render", () => {
    for (const s of FULFILMENT_STAGES) expect(E[`orderTracking.stage.${s}`], s).toBeTruthy();
    for (const s of TRACKING_STEPS) expect(E[`orderTracking.step.${s}`], s).toBeTruthy();
    for (const s of ["done", "current", "upcoming"]) expect(E[`orderTracking.state.${s}`], s).toBeTruthy();
  });
});
