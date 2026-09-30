export const LANGS = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;
export type SearchLang = (typeof LANGS)[number];
