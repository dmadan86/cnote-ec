// Report-brigading controls (security audit). A coordinated group of throw-away accounts must not be able to hide a
// competitor's review or answer by reporting it: auto-hide needs distinct CREDIBLE reporters (verified, aged accounts);
// anything short of that is queued for staff WITHOUT hiding the item. All thresholds are env-configurable.
import { getPersonVerification } from "@cnote/identity";
import { REPORT_THRESHOLD } from "./constants";

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function reportPolicy(env: NodeJS.ProcessEnv = process.env) {
  return {
    /** reports (any reporter) at which an item is considered contested */
    threshold: Math.max(1, num(env.REVIEWS_REPORT_THRESHOLD, REPORT_THRESHOLD)),
    /** distinct credible reporters needed to auto-hide */
    credibleThreshold: Math.max(1, num(env.REVIEWS_REPORT_CREDIBLE_THRESHOLD, REPORT_THRESHOLD)),
    minAccountAgeDays: Math.max(0, num(env.REVIEWS_REPORTER_MIN_AGE_DAYS, 7)),
    perPersonPerHour: Math.max(1, num(env.REVIEWS_REPORTS_PER_PERSON_HOUR, 5)),
    perPersonPerDay: Math.max(1, num(env.REVIEWS_REPORTS_PER_PERSON_DAY, 15)),
    perIpPerHour: Math.max(1, num(env.REVIEWS_REPORTS_PER_IP_HOUR, 30)),
  };
}

export interface ReporterFacts { emailVerified: boolean; phoneVerified: boolean; erased: boolean; createdAt?: string }

/** Credible = a real, verified (email or phone), non-erased account older than the minimum age. Unknown age fails closed. */
export function isCredibleReporter(v: ReporterFacts | null | undefined, now = new Date(), policy = reportPolicy()): boolean {
  if (!v || v.erased || !(v.emailVerified || v.phoneVerified)) return false;
  const created = v.createdAt ? Date.parse(v.createdAt) : NaN;
  return Number.isFinite(created) && now.getTime() - created >= policy.minAccountAgeDays * 86_400_000;
}

/** Number of distinct credible accounts among these reporters. */
export async function countCredibleReporters(personIds: string[], now = new Date(), policy = reportPolicy()): Promise<number> {
  const ids = [...new Set(personIds)].slice(0, 100);
  const facts = await Promise.all(ids.map((id) => getPersonVerification(id).catch(() => null)));
  return facts.filter((f) => isCredibleReporter(f, now, policy)).length;
}
