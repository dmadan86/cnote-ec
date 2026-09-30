import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES, isLocale, bcp47 } from "../src/i18n/config";
import { KNOWN_NAMESPACES, loadMessages } from "../src/i18n/messages";

type Json = { [k: string]: Json | string };
const DIR = join(__dirname, "..", "messages");
const read = (f: string): Json => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Json;
const flat = (o: Json, p = ""): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (k.startsWith("_") ? a : typeof v === "string" ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const enFiles = files.filter((f) => /^en(\.[\w-]+)?\.json$/.test(f));

describe("seller catalogues", () => {
  it("every English file has a counterpart in every locale", () => {
    for (const f of enFiles) for (const l of LOCALES) expect(files, `${l} for ${f}`).toContain(f.replace(/^en/, l));
  });

  it("identical keys and placeholders in every locale; no empty strings", () => {
    for (const f of enFiles) {
      const en = flat(read(f));
      for (const l of LOCALES) {
        const other = flat(read(f.replace(/^en/, l)));
        expect(Object.keys(other).sort(), `${l}: ${f}`).toEqual(Object.keys(en).sort());
        for (const [k, v] of Object.entries(en)) {
          expect(other[k]!.trim().length, `${l}: ${f} ${k} empty`).toBeGreaterThan(0);
          expect(placeholders(other[k]!), `${l}: ${f} ${k} placeholders`).toEqual(placeholders(v));
        }
      }
    }
  });

  it("namespace files hold exactly their namespace and are registered in KNOWN_NAMESPACES", () => {
    for (const f of enFiles.filter((x) => x !== "en.json")) {
      const ns = f.slice(3, -5);
      expect(Object.keys(read(f)), f).toEqual([ns]);
      expect(KNOWN_NAMESPACES, f).toContain(ns);
    }
  });

  it("loads merged catalogues; every locale has every key", async () => {
    const en = await loadMessages("en");
    expect((en.shell as Json).signOut).toBe("Sign out");
    for (const l of LOCALES.filter((x) => x !== "en")) {
      const m = await loadMessages(l);
      expect((m.shell as Json).signOut, l).not.toBe("Sign out");
      expect(Object.keys(flat(m)).sort(), l).toEqual(Object.keys(flat(en)).sort());
    }
  });

  it("config helpers", () => {
    expect(isLocale("ta")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(bcp47("mr")).toBe("mr-IN");
  });
});
