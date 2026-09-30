import { intlTag } from "@/i18n/config";
/** Badge tones per campaign status; the visible labels live in the `ads.status.*` catalogue keys. */
export const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "brand"> = {
  draft: "neutral",
  pending_review: "brand",
  approved: "success",
  active: "success",
  paused: "neutral",
  exhausted: "warning",
  suspended: "danger",
  rejected: "danger",
  ended: "neutral",
};

/** Looks up `<prefix>.<key>` in the `ads` namespace, falling back to the raw key for values we have no copy for. */
export function labelOf(t: { (k: string): string; has: (k: string) => boolean }, prefix: string, key: string): string {
  return t.has(`${prefix}.${key}`) ? t(`${prefix}.${key}`) : key;
}

export const inr = (paise: number, locale = "en") => `₹${(paise / 100).toLocaleString(intlTag(locale), { maximumFractionDigits: 2 })}`;
export const pct = (n: number, locale = "en") => `${n.toLocaleString(intlTag(locale), { maximumFractionDigits: 1 })}%`;
export const num = (n: number, locale = "en") => n.toLocaleString(intlTag(locale));

/** Today in IST as YYYY-MM-DD (kept out of components: `Date.now` is impure during render). */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
