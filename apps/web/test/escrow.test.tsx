import { describe, expect, it } from "vitest";
import bn from "../messages/bn.escrow.json";
import en from "../messages/en.escrow.json";
import gu from "../messages/gu.escrow.json";
import hi from "../messages/hi.escrow.json";
import kn from "../messages/kn.escrow.json";
import mr from "../messages/mr.escrow.json";
import ta from "../messages/ta.escrow.json";
import te from "../messages/te.escrow.json";

type Json = { [k: string]: Json | string };
const flat = (o: Json, p = ""): Record<string, string> => Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === "string" ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const ph = (m: string) => [...m.matchAll(/\{(\w+)/g)].map((x) => x[1]!).sort().join();

describe("escrow catalogue", () => {
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
  it("the fee copy tells the buyer they pay only the order total", () => {
    expect(E["escrow.feeDisclosure"]).toContain("{amount}");
    expect(E["escrow.feeDisclosure"]).toMatch(/never added to your bill/);
  });
});
