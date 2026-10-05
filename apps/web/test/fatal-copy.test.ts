import { describe, expect, it } from "vitest";
import { ALL_LOCALES, LOCALE_COOKIE, LOCALE_META } from "@/i18n/config";
import { detectFatalLocale } from "@/i18n/fatal-locale";
import { FATAL_COPY, FATAL_KEYS } from "@/i18n/fatal-copy";
import { loadMessages } from "@/i18n/messages";

type Errors = Record<string, string>;

describe("fatal-copy mirrors the errors catalogue", () => {
  it.each(ALL_LOCALES)("%s: every key equals messages/<locale>.json errors.*", async (l) => {
    const errors = ((await loadMessages(l)) as unknown as { errors: Errors }).errors;
    for (const k of FATAL_KEYS) {
      expect(errors[k], `${l}: errors.${k}`).toBeTruthy();
      expect(FATAL_COPY[l][k], `${l}: ${k}`).toBe(errors[k]);
    }
  });
  it("Hindi is genuinely Hindi (Devanagari), not an English fallback", () => {
    for (const k of FATAL_KEYS) if (k !== "notFoundCode") expect(FATAL_COPY.hi[k]).toMatch(/[ऀ-ॿ]/);
    expect(LOCALE_META.hi.bcp47).toBe("hi-IN");
  });
});

describe("detectFatalLocale", () => {
  it("uses the /<locale>/ prefix first", () => {
    expect(detectFatalLocale("/hi/typo", null)).toBe("hi");
    expect(detectFatalLocale("/hi", `${LOCALE_COOKIE}=en`)).toBe("hi");
    expect(detectFatalLocale("/typo", null)).toBe("en");
  });
  it("falls back to the cnote_locale cookie on unprefixed routes, then English", () => {
    expect(detectFatalLocale("/account", `a=b; ${LOCALE_COOKIE}=hi; c=d`)).toBe("hi");
    expect(detectFatalLocale("/store/x", `${LOCALE_COOKIE}=hi-IN`)).toBe("hi");
    expect(detectFatalLocale("/account", `${LOCALE_COOKIE}=kn`)).toBe("en"); // disabled locale
    expect(detectFatalLocale("/account", `x${LOCALE_COOKIE}=hi`)).toBe("en");
    expect(detectFatalLocale(null, undefined)).toBe("en");
  });
  it("a disabled locale prefix is not treated as that locale", () => {
    expect(detectFatalLocale("/kn/search", null)).toBe("en");
  });
});
