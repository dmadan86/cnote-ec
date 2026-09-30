import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import hi from "../messages/hi.json";
import { ALL_LOCALES, DEFAULT_LOCALE, disabledLocaleRest, formatNumber, isLocale, isLocalizedPath, LOCALE_META, LOCALES, localizePath, splitLocale, type Locale } from "@/i18n/config";
import { loadLocaleCatalogue, loadMessages } from "@/i18n/messages";
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

const MESSAGES_DIR = join(__dirname, "..", "messages");
const placeholders = (m: string) => [...m.matchAll(/\{(\w+)(?=[,}])/g)].map((x) => x[1]!).sort();
const SCRIPT_RE: Record<string, RegExp> = {
  devanagari: /[ऀ-ॿ]/,
  kannada: /[ಀ-೿]/,
  tamil: /[஀-௿]/,
  telugu: /[ఀ-౿]/,
  gujarati: /[઀-૿]/,
  bengali: /[ঀ-৿]/,
};
// Values that legitimately stay Latin (product names, acronyms, numerals, brand words).
const LATIN_OK = new Set(["unlock.sms", "unlock.whatsapp", "errors.notFoundCode", "consent.provider.clarity"]);
// Catalogues on disk are checked for ALL locales, enabled or not, so re-enabling one is a one-line change.
const TRANSLATED = ALL_LOCALES.filter((l) => l !== "en");
const NEW_LOCALES = TRANSLATED.filter((l) => l !== "hi");
const DISABLED = ALL_LOCALES.filter((l) => !(LOCALES as readonly string[]).includes(l));

// Namespaced catalogue files: en.json plus en.<ns>.json (ads, promotions, ...), every locale must mirror them.
const suffixes = readdirSync(MESSAGES_DIR)
  .map((f) => /^en(\.[\w-]+)?\.json$/.exec(f)?.[1] ?? (f === "en.json" ? "" : null))
  .filter((x): x is string => x !== null)
  .sort();

const readFlat = (locale: string, suffix: string): Record<string, string> | null => {
  try {
    const raw = JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}${suffix}.json`), "utf8")) as Json;
    const ns = suffix.slice(1);
    return flatten(ns && !(ns in raw) ? { [ns]: raw } : raw);
  } catch {
    return null;
  }
};
const allKeys = (locale: string) => Object.fromEntries(suffixes.flatMap((sfx) => Object.entries(readFlat(locale, sfx) ?? {})));
const E = allKeys("en");
const merged = async (locale: Locale) => (await loadLocaleCatalogue(locale)) as Json;

describe("i18n: catalogues", () => {
  it("discovers namespaced files", () => {
    expect(suffixes).toContain("");
  });

  it("hi has every file and every key of en (all namespaced files)", () => {
    for (const sfx of suffixes) {
      const en = readFlat("en", sfx)!;
      const hi = readFlat("hi", sfx);
      expect(hi, `hi${sfx}.json exists`).not.toBeNull();
      expect({ missing: Object.keys(en).filter((k) => !(k in hi!)), extra: Object.keys(hi!).filter((k) => !(k in en)) }, `hi${sfx}`).toEqual({ missing: [], extra: [] });
    }
  });

  it.each(NEW_LOCALES)("%s has every file and every key of en (all namespaced files)", (code) => {
    for (const sfx of suffixes) {
      const en = readFlat("en", sfx)!;
      const cat = readFlat(code, sfx);
      expect(cat, `${code}${sfx}.json exists`).not.toBeNull();
      expect({ missing: Object.keys(en).filter((k) => !(k in cat!)), extra: Object.keys(cat!).filter((k) => !(k in en)) }, `${code}${sfx}`).toEqual({ missing: [], extra: [] });
    }
  });

  it.each(ALL_LOCALES)("%s: every message is valid ICU (locale plural rules) and placeholders match English", async (code) => {
    const cat = await merged(code);
    const flat = flatten(cat);
    const errors: string[] = [];
    const t = createTranslator({ locale: LOCALE_META[code].bcp47, messages: cat as never, onError: (e) => void errors.push(`${e.code}: ${e.message}`) });
    for (const [key, msg] of Object.entries(flat)) {
      // Rich-text tags (<strong>..</strong>, <link>..</link>) need a renderer; the check only cares that the message is valid.
      const tags = [...msg.matchAll(/<(\w+)>/g)].map((x) => [x[1]!, (chunks: unknown) => chunks] as const);
      const values = { ...Object.fromEntries(placeholders(msg).map((p) => [p, p === "count" || p === "n" ? 3 : "X"])), ...Object.fromEntries(tags) };
      expect(() => (t as (k: string, v: unknown) => string)(key, values), key).not.toThrow();
    }
    expect(errors, code).toEqual([]);
    const mismatched = Object.keys(E).filter((k) => flat[k] && placeholders(flat[k]!).join() !== placeholders(E[k]!).join());
    expect(mismatched).toEqual([]);
  });

  it.each(TRANSLATED)("%s has no untranslated English left", (code) => {
    const H = allKeys(code);
    const script = SCRIPT_RE[LOCALE_META[code].script]!;
    const untranslated = Object.entries(H)
      .filter(([k, v]) => !LATIN_OK.has(k) && !script.test(v))
      // Placeholders and punctuation don't count; short Latin tokens (acronyms, "SMS") are fine, sentences are not.
      .filter(([, v]) => v.replace(/\{[^}]*\}/g, " ").replace(/[^A-Za-z\s]/g, " ").trim().split(/\s+/).filter(Boolean).length > 1)
      .map(([k, v]) => `${k}: ${v}`);
    expect(untranslated).toEqual([]);
    const identical = Object.entries(H).filter(([k, v]) => v === E[k] && v.length > 12 && !LATIN_OK.has(k));
    expect(identical.map(([k]) => k)).toEqual([]);
  });

  it.each(TRANSLATED)("marks the %s catalogue as machine-drafted", (code) => {
    const raw = JSON.parse(readFileSync(join(MESSAGES_DIR, `${code}.json`), "utf8")) as Json;
    expect(raw._meta).toMatch(/MACHINE-DRAFTED, NEEDS NATIVE REVIEW/i);
  });

  it("falls back per key to English when a key is missing", async () => {
    const all = flatten((await loadMessages("kn")) as unknown as Json);
    expect(Object.keys(E).filter((k) => !(k in all))).toEqual([]);
  });

  it("merges namespaced files deterministically", async () => {
    const a = JSON.stringify(await loadLocaleCatalogue("en"));
    expect(JSON.stringify(await loadLocaleCatalogue("en"))).toBe(a);
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
  it("emits self-referencing canonicals with hreflang alternates (enabled locales only) and x-default", () => {
    expect(localizedAlternates("/c/packaging", "hi")).toEqual({
      canonical: "/hi/c/packaging",
      languages: { "en-IN": "/c/packaging", "hi-IN": "/hi/c/packaging", "x-default": "/c/packaging" },
    });
    expect(localizedAlternates("/", "en").canonical).toBe("/");
    expect(localizedAlternates("/", "hi").languages).toMatchObject({ "hi-IN": "/hi", "en-IN": "/" });
    expect(sitemapLanguages("/pricing", (p) => `https://x.test${p}`)).toEqual({ "en-IN": "https://x.test/pricing", "hi-IN": "https://x.test/hi/pricing", "x-default": "https://x.test/pricing" });
    expect(Object.keys(sitemapLanguages("/pricing", (p) => p))).toHaveLength(LOCALES.length + 1);
  });
  it("never emits a disabled locale in hreflang alternates or the sitemap", () => {
    for (const code of DISABLED) {
      const tag = LOCALE_META[code].hreflang;
      expect(Object.keys(localizedAlternates("/c/packaging", "hi").languages)).not.toContain(tag);
      expect(Object.keys(sitemapLanguages("/pricing", (p) => p))).not.toContain(tag);
    }
  });
  it("gives every active locale a distinct BCP 47 tag", () => {
    expect(new Set(LOCALES.map((l) => LOCALE_META[l].bcp47)).size).toBe(LOCALES.length);
  });
  it("sets <html lang> per locale from the route segment", () => {
    const props = { className: "x", messages: {}, skip: null, header: null, footer: null, extras: null };
    mockPath = "/hi/search";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toMatch(/<html lang="hi-IN"/);
    for (const code of DISABLED) {
      mockPath = `/${code}/search`; // disabled locale segments are not localised: the shell stays en-IN
      expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toContain('<html lang="en-IN"');
    }
    mockPath = "/en/search";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toMatch(/<html lang="en-IN"/);
    mockPath = "/account";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toMatch(/<html lang="en-IN"/);
  });
});

describe("i18n: locales", () => {
  it("routes only enabled locale prefixes and groups numbers the Indian way with Latin digits", () => {
    expect([...LOCALES]).toEqual(["en", "hi"]);
    expect(splitLocale("/hi/c/x")).toEqual({ locale: "hi", prefixed: true, rest: "/c/x" });
    expect(localizePath("/p/abc", "hi")).toBe("/hi/p/abc");
    for (const code of ALL_LOCALES) expect(formatNumber(1234567, code)).toBe("12,34,567");
  });
  it("disabled locales are not routable: isLocale/splitLocale reject them and disabledLocaleRest maps them to English paths", () => {
    for (const code of DISABLED) {
      expect(isLocale(code)).toBe(false);
      expect(splitLocale(`/${code}/c/x`).prefixed).toBe(false);
      expect(disabledLocaleRest(`/${code}/c/x`)).toBe("/c/x");
      expect(disabledLocaleRest(`/${code}`)).toBe("/");
    }
    for (const p of ["/hi/c/x", "/en/x", "/c/x", "/zz/x", "/account"]) expect(disabledLocaleRest(p), p).toBeNull();
  });
  it("preferredLocale ignores disabled languages and picks the first enabled one", async () => {
    const { preferredLocale } = await import("@/i18n/language-suggestion");
    expect(preferredLocale(["ta-IN", "hi"])).toBe("hi");
    expect(preferredLocale(["fr", "bn"])).toBeNull();
    expect(preferredLocale(["ta-IN"])).toBeNull();
  });
  it("lists every enabled locale (and no disabled one) in the switcher with a lang attribute and its native name", () => {
    mockPath = "/search";
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{ lang: en.lang }}>
        <LanguageSwitcher />
      </NextIntlClientProvider>,
    );
    for (const code of LOCALES) expect(html).toContain(`<option value="${code}" lang="${code}-IN"`);
    for (const code of LOCALES) expect(html).toContain(`>${LOCALE_META[code].native}</option>`);
    for (const code of DISABLED) expect(html).not.toContain(`value="${code}"`);
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
