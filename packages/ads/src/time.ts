// IST day/hour helpers (the ad budget day boundary is IST, design 5.1). Pure.
const IST_OFFSET_MS = 5.5 * 3_600_000;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Start (as a UTC instant) of the IST calendar day containing `at`. */
export function istDayStart(at: Date): Date {
  const shifted = at.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** "YYYY-MM-DD" of the IST day containing `at`. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Fraction (0..1) of the IST day elapsed at `at`. */
export function istDayFraction(at: Date): number {
  return (at.getTime() - istDayStart(at).getTime()) / DAY_MS;
}

export function hourStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** Stable key for an hour bucket, e.g. "2026-09-30T05". */
export function hourKey(at: Date): string {
  return hourStart(at).toISOString().slice(0, 13);
}
