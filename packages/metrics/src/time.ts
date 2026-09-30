// Metric days are IST calendar days ("YYYY-MM-DD"); MetricDaily.day stores that date at UTC midnight.
import { DomainError } from "@cnote/core";

export const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDay(day: string): string {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new DomainError("validation", `Invalid day "${day}" (expected YYYY-MM-DD)`);
  }
  return day;
}

/** IST calendar day of an instant. */
export function istDay(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${assertDay(day)}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** [start, end) instants of an IST day. */
export function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${assertDay(day)}T00:00:00Z`) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function dayToDate(day: string): Date {
  return new Date(`${assertDay(day)}T00:00:00Z`);
}

export function dateToDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of days from..to. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = assertDay(from); d <= assertDay(to); d = addDays(d, 1)) out.push(d);
  return out;
}

/** True once the follow-up window of `day` has fully elapsed. */
export function isMatured(day: string, windowDays: number, now: Date = new Date()): boolean {
  return dayBounds(day).end.getTime() + windowDays * DAY_MS <= now.getTime();
}
