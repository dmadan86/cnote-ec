import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_LOCALES, isLocalizedPath } from "@/i18n/config";
import { DOC_LINKS, INFO_PAGES } from "@/features/legal/docs";

type Json = { [k: string]: Json | Json[] | string | string[] };
const load = (l: string) => (JSON.parse(readFileSync(join(__dirname, "..", "messages", `${l}.legal.json`), "utf8")) as { legal: Json }).legal;

const strings = (v: unknown, path = ""): [string, string][] =>
  typeof v === "string" ? [[path, v]] : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => strings(x, `${path}.${k}`)) : [];
const tokens = (s: string) => [...s.matchAll(/\[\[(\w+)\]\]/g)].map((m) => m[1]!).sort();
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("legal copy", () => {
  const en = strings(load("en"));

  it("only uses link tokens that exist, and each has a label", () => {
    const labels = (load("en").links ?? {}) as Record<string, string>;
    for (const [path, s] of en) for (const k of tokens(s)) {
      expect(k in DOC_LINKS, `${path}: [[${k}]]`).toBe(true);
      expect(labels[k], `label for ${k}`).toBeTruthy();
    }
  });

  it.each(ALL_LOCALES.filter((l) => l !== "en"))("%s keeps the link tokens, placeholders and array shapes of English", (l) => {
    const other = new Map(strings(load(l)));
    for (const [path, s] of en) {
      if (path.startsWith("._meta")) continue;
      const o = other.get(path);
      expect(o, `${l}${path} exists`).toBeDefined();
      expect(tokens(o!), `${l}${path} tokens`).toEqual(tokens(s));
      expect(placeholders(o!), `${l}${path} placeholders`).toEqual(placeholders(s));
    }
  });

  it("every policy and info page is localised", () => {
    for (const p of INFO_PAGES) if (p.key !== "help" && p.key !== "grievance") expect(isLocalizedPath(DOC_LINKS[p.key]), p.key).toBe(true);
  });
});
