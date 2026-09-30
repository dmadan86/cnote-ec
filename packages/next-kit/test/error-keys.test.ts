import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanKeyedSites } from "./domain-error-scan";

// Source-level keys (DomainError 4th argument): every one must be translated in both apps, in all 8 locales, with the
// same ICU placeholders as the English message and the `params` passed at the call site.
const ROOT = join(__dirname, "..", "..", "..");
const LOCALES = ["en", "hi", "bn", "ta", "te", "mr", "gu", "kn"] as const;
type Json = { [k: string]: Json | string };

const load = (app: "seller" | "web", l: string): Json => (JSON.parse(readFileSync(join(ROOT, "apps", app, "messages", `${l}.errors.json`), "utf8")) as { errors: Json }).errors;
const at = (o: Json, path: string): string | undefined => {
  let cur: Json | string | undefined = o;
  for (const p of path.split(".")) cur = typeof cur === "object" && cur !== null ? cur[p] : undefined;
  return typeof cur === "string" ? cur : undefined;
};
const slots = (s: string) => [...s.matchAll(/\{(\w+)[},]/g)].map((m) => m[1]!).sort();
const sites = scanKeyedSites();

describe("explicit DomainError keys", () => {
  it("finds the keyed call sites", () => expect(sites.length).toBeGreaterThan(200));

  it("the same key is never used for two different messages", () => {
    const byKey = new Map<string, string>();
    for (const s of sites) {
      const seen = byKey.get(s.key);
      if (seen !== undefined) expect(s.message, `${s.key} (${s.file})`).toBe(seen);
      byKey.set(s.key, s.message);
    }
  });

  it("params passed at the call site match the placeholders in the English message", () => {
    for (const s of sites) expect(slots(s.message), `${s.key} (${s.file})`).toEqual([...new Set(s.params)].sort());
  });

  for (const app of ["seller", "web"] as const) {
    it(`${app}: every key is translated in all 8 locales with matching placeholders; en equals the source message`, () => {
      const cat = Object.fromEntries(LOCALES.map((l) => [l, load(app, l)]));
      for (const s of sites) {
        for (const l of LOCALES) {
          const text = at(cat[l]!, s.key);
          expect(text, `${app}/${l}: errors.${s.key}`).toBeTruthy();
          expect(slots(text!), `${app}/${l}: placeholders of errors.${s.key}`).toEqual(slots(s.message));
        }
        expect(at(cat.en!, s.key), `${app}/en: errors.${s.key}`).toBe(s.message);
      }
    });
  }
});
