// Seller-app i18n (ADR-004: vernacular-first seller experience). Same 8 languages as the buyer web. The seller app is
// fully dynamic (every page reads the session), so the locale comes from a cookie instead of a URL prefix.
export const LOCALES = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "seller_locale";

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** Language name in its own script (switcher options carry lang= for correct pronunciation by screen readers). */
export const LOCALE_NATIVE: Record<Locale, string> = {
  en: "English", hi: "हिन्दी", kn: "ಕನ್ನಡ", ta: "தமிழ்", te: "తెలుగు", mr: "मराठी", gu: "ગુજરાતી", bn: "বাংলা",
};

/** BCP 47 tag for <html lang> and Intl formatting (Latin digits). */
export const bcp47 = (l: Locale): string => `${l}-IN`;
