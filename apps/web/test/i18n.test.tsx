import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import hi from "../messages/hi.json";
import { DEFAULT_LOCALE, isLocalizedPath, LOCALE_META, LOCALES, localizePath, PLANNED_LOCALES, splitLocale } from "@/i18n/config";
import { localizedAlternates, sitemapLanguages } from "@/lib/seo-i18n";

let mockPath = "/hi/search";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push: () => undefined }),
  useSelectedLayoutSegment: () => mockPath.split("/")[1] || null,
}));
// Imported after the mock so the components see it.
const { LanguageSwitcher } = await import("@/i18n/language-switcher");
const { HtmlShell } = await import("@/i18n/html-shell");

type Json = { [k: string]: Json | string };
const flatten = (o: Json, prefix = ""): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
    if (k.startsWith("_")) return acc; // _meta / _todo markers
    return typeof v === "string" ? { ...acc, [prefix + k]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) };
  }, {});

const E = flatten(en as Json);
const H = flatten(hi as Json);
const placeholders = (m: string) => [...m.matchAll(/\{(\w+)(?=[,}])/g)].map((x) => x[1]!).sort();
const DEVANAGARI = /[ऀ-ॿ]/;
// Values that legitimately stay Latin in Hindi (product names, acronyms, numerals, brand words).
const LATIN_OK = new Set(["unlock.sms", "unlock.whatsapp", "errors.notFoundCode"]);

describe("i18n: catalogues", () => {
  it("hi.json has exactly the keys of en.json", () => {
    const missing = Object.keys(E).filter((k) => !(k in H));
    const extra = Object.keys(H).filter((k) => !(k in E));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("every message is a valid ICU message and placeholders match English", () => {
    for (const [name, messages] of [["en", en], ["hi", hi]] as const) {
      const errors: string[] = [];
      const t = createTranslator({ locale: LOCALE_META[name].bcp47, messages: messages as never, onError: (e) => void errors.push(`${e.code}: ${e.message}`) });
      for (const [key, msg] of Object.entries(name === "en" ? E : H)) {
        const values = Object.fromEntries(placeholders(msg).map((p) => [p, p === "count" || p === "n" ? 3 : "X"]));
        expect(() => (t as (k: string, v: unknown) => string)(key, values), key).not.toThrow();
      }
      expect(errors, name).toEqual([]);
    }
    const mismatched = Object.keys(E).filter((k) => H[k] && placeholders(H[k]).join() !== placeholders(E[k]!).join());
    expect(mismatched).toEqual([]);
  });

  it("hi.json has no untranslated English left", () => {
    const untranslated = Object.entries(H)
      .filter(([k, v]) => !LATIN_OK.has(k) && !DEVANAGARI.test(v))
      // Placeholders and punctuation don't count; short Latin tokens (acronyms, "SMS") are fine, sentences are not.
      .filter(([, v]) => v.replace(/\{[^}]*\}/g, " ").replace(/[^A-Za-z\s]/g, " ").trim().split(/\s+/).filter(Boolean).length > 1)
      .map(([k, v]) => `${k}: ${v}`);
    expect(untranslated).toEqual([]);
    const identical = Object.entries(H).filter(([k, v]) => v === E[k] && v.length > 12);
    expect(identical.map(([k]) => k)).toEqual([]);
  });

  it("marks the Hindi catalogue as machine-drafted", () => {
    expect((hi as Json)._meta).toMatch(/MACHINE-DRAFTED, NEEDS NATIVE REVIEW/);
  });

  it("planned locales only contain keys that exist in English (they fall back to it)", async () => {
    for (const code of PLANNED_LOCALES) {
      const cat = (await import(`../messages/${code}.json`)).default as Json;
      expect(Object.keys(flatten(cat)).filter((k) => !(k in E)), code).toEqual([]);
      expect(String(cat._todo), code).toMatch(/TODO/);
    }
  });
});

describe("i18n: routing helpers", () => {
  it("keeps the default locale unprefixed and prefixes others", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(localizePath("/search?q=x", "en")).toBe("/search?q=x");
    expect(localizePath("/search?q=x", "hi")).toBe("/hi/search?q=x");
    expect(localizePath("/", "hi")).toBe("/hi");
    expect(localizePath("/?rail=new#popular", "hi")).toBe("/hi?rail=new#popular");
    expect(localizePath("/p/abc", "hi")).toBe("/hi/p/abc");
  });
  it("never prefixes non-localised, external or protocol-relative links", () => {
    for (const p of ["/rfq/new", "/signin", "/account", "/buyer/enquiries", "https://x.test/", "//cdn.test/x", "/store/acme"]) expect(localizePath(p, "hi")).toBe(p);
  });
  it("splits locale prefixes and knows which paths are localised", () => {
    expect(splitLocale("/hi/c/packaging")).toEqual({ locale: "hi", prefixed: true, rest: "/c/packaging" });
    expect(splitLocale("/hi")).toEqual({ locale: "hi", prefixed: true, rest: "/" });
    expect(splitLocale("/search")).toEqual({ locale: "en", prefixed: false, rest: "/search" });
    expect(splitLocale("/zz/search").prefixed).toBe(false);
    expect(isLocalizedPath("/")).toBe(true);
    expect(isLocalizedPath("/c/x")).toBe(true);
    expect(isLocalizedPath("/searchx")).toBe(false);
    expect(isLocalizedPath("/account")).toBe(false);
  });
});

describe("i18n: SEO", () => {
  it("emits self-referencing canonicals with hreflang alternates and x-default", () => {
    expect(localizedAlternates("/c/packaging", "hi")).toEqual({
      canonical: "/hi/c/packaging",
      languages: { "en-IN": "/c/packaging", "hi-IN": "/hi/c/packaging", "x-default": "/c/packaging" },
    });
    expect(localizedAlternates("/", "en").canonical).toBe("/");
    expect(localizedAlternates("/", "hi").languages).toMatchObject({ "hi-IN": "/hi", "en-IN": "/" });
    expect(sitemapLanguages("/pricing", (p) => `https://x.test${p}`)).toEqual({ "en-IN": "https://x.test/pricing", "hi-IN": "https://x.test/hi/pricing", "x-default": "https://x.test/pricing" });
  });
  it("gives every active locale a distinct BCP 47 tag", () => {
    expect(new Set(LOCALES.map((l) => LOCALE_META[l].bcp47)).size).toBe(LOCALES.length);
  });
  it("sets <html lang> per locale from the route segment", () => {
    const props = { className: "x", messages: {}, skip: null, header: null, footer: null, extras: null };
    mockPath = "/hi/search";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toMatch(/<html lang="hi-IN"/);
    mockPath = "/en/search";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toMatch(/<html lang="en-IN"/);
    mockPath = "/account";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toMatch(/<html lang="en-IN"/);
  });
});

describe("i18n: static rendering guard", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  it("localised routes and the i18n layer never read cookies/headers (would make public pages dynamic)", () => {
    const root = join(__dirname, "..", "src");
    for (const f of [...files(join(root, "i18n")), ...files(join(root, "app", "[locale]"))].filter((f) => /\.tsx?$/.test(f))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from "next\/headers"|\bcookies\(\)|\bheaders\(\)/);
    }
  });
});

describe("a11y: language switcher", () => {
  const render = (path: string, locale: "en" | "hi") => {
    mockPath = path;
    return renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={locale === "hi" ? { lang: hi.lang } : { lang: en.lang }}>
        <LanguageSwitcher />
      </NextIntlClientProvider>,
    );
  };
  it("has a visible label bound to the select, a lang attribute on each option and the current locale selected", () => {
    const html = render("/hi/search", "hi");
    const id = /<select id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(">भाषा</label>");
    expect(html).toMatch(/<option value="en" lang="en-IN"[^>]*>English<\/option>/);
    expect(html).toMatch(/<option value="hi" lang="hi-IN"[^>]*selected=""[^>]*>हिन्दी<\/option>/);
  });
  it("keeps the current path in the no-JS fallback links", () => {
    const html = render("/hi/c/packaging", "hi");
    expect(html).toContain('href="/c/packaging"');
    expect(html).toContain('href="/hi/c/packaging"');
    expect(html).toMatch(/hrefLang="en-IN"|hreflang="en-IN"/i);
  });
  it("falls back to the other language's home on pages that are not localised", () => {
    const html = render("/account", "en");
    expect(html).toContain('href="/hi"');
    expect(html).toContain('href="/"');
  });
});
