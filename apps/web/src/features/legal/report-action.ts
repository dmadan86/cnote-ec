"use server";
import { fileGrievance } from "@cnote/compliance";
import { currentSession, type ActionResult } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { runLocalized } from "@/i18n/errors";
import { reportToTicket, validateReport } from "./report";

export interface FiledReport {
  id: string;
}

/**
 * Public abuse / IPR takedown report. Files a grievance ticket with category "report" through @cnote/compliance (same
 * queue, acknowledgement SLA and rate limit as other grievances). Works signed in or anonymous. The page locale arrives as
 * a hidden field because this static page has no cookie-based locale.
 */
export async function fileReportAction(_prev: ActionResult<FiledReport> | null, fd: FormData): Promise<ActionResult<FiledReport>> {
  const rawLocale = fd.get("locale");
  const locale = typeof rawLocale === "string" && isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "legal" });
  const checked = validateReport(Object.fromEntries(fd.entries()));
  if (!checked.ok) {
    const fieldErrors = Object.fromEntries(Object.entries(checked.errors).map(([f, code]) => [f, t(`report.err.${code}`)]));
    return { ok: false, error: t("report.form.errorSummary"), fieldErrors };
  }
  const s = await currentSession();
  const { subject, body } = reportToTicket(checked.value);
  return runLocalized(async () => {
    const g = await fileGrievance({ personId: s?.personId, contactEmail: checked.value.email, category: "report", subject, body });
    return { id: g.id };
  }, locale);
}
