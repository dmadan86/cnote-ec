import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../src/i18n/config";

type Json = { [k: string]: Json | string };
const read = (l: string): Json => JSON.parse(readFileSync(join(__dirname, "..", "messages", `${l}.prices.json`), "utf8")) as Json;
const ph = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort().join();

describe("seller prices catalogue", () => {
  const en = read("en").prices as Json;
  for (const l of LOCALES.filter((x) => x !== "en")) {
    it(`${l}: same keys and placeholders as en, translated, flagged for review`, () => {
      const f = read(l);
      expect(Object.keys(f).sort()).toEqual(["_meta", "prices"]);
      const p = f.prices as Json;
      expect(Object.keys(p).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) { expect(ph(p[k] as string), k).toBe(ph(en[k] as string)); if (k !== "bandScope") expect(p[k], k).not.toBe(en[k]); }
    });
  }
  it("en has only the prices key", () => expect(Object.keys(read("en"))).toEqual(["prices"]));
});
