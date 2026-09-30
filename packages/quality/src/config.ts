// Configuration for ADR-015 quality checks. Everything is read per call so ops/tests can flip it.

/** Master switch. Off by default: nothing is analysed, nothing is shown. */
export const qualityChecksEnabled = (): boolean => process.env.QUALITY_CHECKS_ENABLED === "true";

/** Deploy-time evaluation/pilot allowlist (comma-separated category slugs). The gated DB toggle adds to it. */
export function envCategories(): string[] {
  return (process.env.QUALITY_CHECK_CATEGORIES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

/** ADR-015: expansion needs accuracy strictly above this on the labelled set... */
export const minAccuracy = (): number => num(process.env.QUALITY_MIN_ACCURACY, 0.9);
/** ...with at least this many staff labels. */
export const minLabels = (): number => Math.max(1, Math.trunc(num(process.env.QUALITY_MIN_LABELS, 50)));

export const MAX_PHOTOS_PER_CHECK = 4;
export const MAX_CHECKS_PER_ORDER = 3;
export const SUBMISSIONS_PER_HOUR = 10;
/** Photos are personal/commercial data (DPDP): the object is deleted after this many days, the row stays. */
export const QUALITY_MEDIA_RETENTION_DAYS = 180;
/** Order statuses in which a seller may still share pre-dispatch photos (before or at dispatch). */
export const SUBMITTABLE_ORDER_STATUSES = ["recorded", "confirmed", "dispatched"] as const;
export const ANALYSE_TOPIC = "quality.analyse" as const;
