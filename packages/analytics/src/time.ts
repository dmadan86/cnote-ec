// Day buckets are IST calendar days stored as that date at UTC midnight (same convention as @cnote/metrics).
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** IST calendar day of an instant, as a Date at UTC midnight (what a `@db.Date` column stores). */
export function istDate(at: Date | string): Date {
  const d = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** First day of the IST month of an instant. */
export function istMonth(at: Date | string): Date {
  const d = istDate(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
