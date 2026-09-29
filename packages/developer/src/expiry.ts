export const EXPIRY_OPTIONS = ["1d", "7d", "30d", "90d", "1y", "never"] as const;
export type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

export const EXPIRY_LABELS: Record<ExpiryOption, string> = {
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
  never: "No expiration",
};

const DAY_MS = 86_400_000;
const DAYS: Partial<Record<ExpiryOption, number>> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };

/** Absolute expiry for an option, or null for "never". */
export function expiryToDate(option: ExpiryOption, now: Date = new Date()): Date | null {
  if (option === "never") return null;
  if (option === "1y") {
    const d = new Date(now);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d;
  }
  return new Date(now.getTime() + (DAYS[option] as number) * DAY_MS);
}
