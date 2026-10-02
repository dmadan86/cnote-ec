import type { SupplierTrust } from "./model";
import { acceptPercent, formatEvidenceDate, splitDuration } from "./model";

type T = (key: string, values?: Record<string, string | number>) => string;

export interface EvidenceItem {
  key: string;
  label: string;
  description: string;
  passed: boolean;
  /** "Passed 3 Jan 2026" or "Not completed": text, so state is never conveyed by colour/icon alone */
  status: string;
}

/** Evidence rows for the disclosure and the Verification tab (`t` = supplier namespace translator). */
export function evidenceItems(trust: SupplierTrust, t: T, bcp47: string): EvidenceItem[] {
  return trust.checks.map((c) => ({
    key: c.key,
    label: t(`checks.${c.key}`),
    description: t(`checkDesc.${c.key}`),
    passed: c.passed,
    status: c.passed && c.at ? t("evidence.passedOn", { date: formatEvidenceDate(c.at, bcp47) }) : t("evidence.notDone"),
  }));
}

/** Plain-text summaries of the response metrics; null values mean "New supplier" (below the sample threshold). */
export function responseText(trust: SupplierTrust, t: T): { time: string | null; accept: string | null } {
  const r = trust.response;
  if (r.isNew) return { time: null, accept: null };
  let time: string;
  if (r.medianFirstResponseMinutes == null) time = t("values.noReplies");
  else {
    const d = splitDuration(r.medianFirstResponseMinutes);
    time = t(`values.${d.unit}`, { n: d.value });
  }
  const pct = acceptPercent(r.acceptRate);
  return { time, accept: pct == null ? null : t("values.acceptPct", { pct }) };
}

export function yearsText(trust: SupplierTrust, t: T): string {
  return trust.yearsOnPlatform >= 1 ? t("values.years", { years: trust.yearsOnPlatform }) : t("values.joinedYear", { year: trust.memberSinceYear });
}
