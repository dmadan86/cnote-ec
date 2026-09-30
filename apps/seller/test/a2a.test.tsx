import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../src/i18n/config";
import { paiseToRupeeText, rupeesToPaiseExact } from "../src/features/a2a/money";
import { Transcript } from "../src/features/a2a/transcript";

type Json = { [k: string]: Json | string };
const ROOT = join(__dirname, "..");
const read = (f: string): Json => JSON.parse(readFileSync(join(ROOT, "messages", f), "utf8")) as Json;
const flat = (o: Json, p = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (k.startsWith("_") ? [] : typeof v === "string" ? [p + k] : flat(v, `${p}${k}.`)));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
const at = (o: Json, path: string): string | undefined => {
  let cur: Json | string | undefined = o;
  for (const part of path.split(".")) cur = typeof cur === "object" && cur !== null ? cur[part] : undefined;
  return typeof cur === "string" ? cur : undefined;
};
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });

const en = read("en.a2a.json");

describe("a2a messages", () => {
  it("top-level key is a2a with identical keys and placeholders in all 8 locales; non-English are marked for review", () => {
    const keys = flat(en).sort();
    expect(keys.length).toBeGreaterThan(100);
    for (const l of LOCALES) {
      const f = read(`${l}.a2a.json`);
      expect(Object.keys(f).filter((k) => !k.startsWith("_")), l).toEqual(["a2a"]);
      if (l !== "en") expect((f._meta as Json).review, l).toBe("machine-drafted; needs native review");
      expect(flat(f).sort(), l).toEqual(keys);
      for (const k of keys) {
        const v = at(f, k)!;
        expect(v.trim().length, `${l} ${k}`).toBeGreaterThan(0);
        expect(placeholders(v), `${l} ${k}`).toEqual(placeholders(at(en, k)!));
      }
    }
  });

  it("every t('...') key used by the a2a components and pages exists in English", () => {
    const files = [...walk(join(ROOT, "src/features/a2a")), ...walk(join(ROOT, "src/app/(portal)/agents"))];
    let checked = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const ns = [...src.matchAll(/(?:useTranslations|getTranslations)\("([\w.]+)"\)/g)].map((m) => m[1]!);
      if (ns.length === 0) continue;
      expect(new Set(ns).size, `${file}: one namespace per file`).toBe(1);
      const prefix = ns[0] === "a2a" ? "" : `${ns[0]!.slice(4)}.`;
      for (const m of src.matchAll(/\bt(?:\.rich)?\(\s*"([\w.]+)"/g)) {
        expect(at(en, `a2a.${prefix}${m[1]}`), `${file}: ${m[1]}`).toBeTypeOf("string");
        checked++;
      }
      // dynamic keys t(`status.${x}`): the prefix must be an object with entries
      for (const m of src.matchAll(/\bt\(\s*`([\w.]+)\.\$\{/g)) {
        let cur: Json | string | undefined = en.a2a;
        for (const part of `${prefix}${m[1]}`.split(".").filter(Boolean)) cur = typeof cur === "object" ? cur[part] : undefined;
        expect(typeof cur, `${file}: ${m[1]}.*`).toBe("object");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("dynamic keys cover every status, actor, type and confirmation value", () => {
    const a2a = en.a2a as Json;
    for (const s of ["active", "paused", "revoked", "expired", "completed", "suspended"]) expect((a2a.mandateStatus as Json)[s], s).toBeTypeOf("string");
    for (const s of ["open", "agreed", "accepted", "rejected", "withdrawn", "expired"]) expect((a2a.negotiationStatus as Json)[s], s).toBeTypeOf("string");
    const tr = a2a.transcript as Json;
    for (const s of ["agent", "external_agent", "person"]) expect((tr.actor as Json)[s], s).toBeTypeOf("string");
    for (const s of ["offer", "counter", "accept", "reject", "withdraw"]) expect((tr.type as Json)[s], s).toBeTypeOf("string");
    for (const s of ["pending", "human", "auto", "declined"]) expect(((a2a.negotiation as Json).conf as Json)[s], s).toBeTypeOf("string");
  });
});

describe("rupee <-> paise", () => {
  it("converts exactly, with no float drift", () => {
    expect(rupeesToPaiseExact("1250")).toBe(125000);
    expect(rupeesToPaiseExact("1,250.5")).toBe(125050);
    expect(rupeesToPaiseExact("0.29")).toBe(29);
    expect(rupeesToPaiseExact("19.99")).toBe(1999);
    expect(rupeesToPaiseExact("1.005")).toBeNull();
    for (const bad of ["", "0", "-5", "abc", "1e3", "1.", ".5"]) expect(rupeesToPaiseExact(bad), bad).toBeNull();
    expect(paiseToRupeeText(125050)).toBe("1250.5");
    expect(paiseToRupeeText(125005)).toBe("1250.05");
    expect(paiseToRupeeText(100)).toBe("1");
    expect(paiseToRupeeText(null)).toBe("");
  });
});

describe("Transcript", () => {
  it("renders one typed row per message and never a counterparty limit", async () => {
    const offer = { pricePaise: 125000, quantity: 500, unit: "piece", leadTimeDays: 7, deliveryTerms: "Ex-works", validUntil: "2026-10-30T00:00:00.000Z", paymentTerms: "50% advance" };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{ a2a: en.a2a as Json }}>
        <Transcript
          n={{
            buyer: { businessId: "b", name: "Buyer Co" }, seller: { businessId: "s", name: "Seller Co" },
            messages: [
              { seq: 1, side: "seller", type: "offer", offer, actor: "agent", mine: true, createdAt: "2026-09-30T10:00:00.000Z" },
              { seq: 2, side: "buyer", type: "counter", offer: { ...offer, pricePaise: 120000 }, actor: "agent", mine: false, createdAt: "2026-09-30T10:01:00.000Z" },
              { seq: 3, side: "seller", type: "accept", offer: null, actor: "person", mine: true, createdAt: "2026-09-30T10:02:00.000Z" },
            ],
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(html).toContain("Buyer Co");
    expect(html).toContain("Counter");
    expect(html).toContain("1,200");
    expect(html).toContain("50% advance");
    expect(html.match(/<tr/g)?.length).toBe(4);
  });
});
