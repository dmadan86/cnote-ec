"use server";
import { fileGrievance, GRIEVANCE_CATEGORIES, REQUEST_TYPES } from "@cnote/compliance";
import { currentSession, type ActionResult } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

export interface FiledGrievance {
  id: string;
  dueAt: string;
  /** an anonymous data-rights request: we emailed a signed link and cannot act until it is used */
  verificationRequired: boolean;
}

/** Public grievance filing (DPDP Act grievance redressal; IT Rules 2021 r.3(2)). Works signed-in or anonymous. */
export async function fileGrievanceAction(_prev: ActionResult<FiledGrievance> | null, fd: FormData): Promise<ActionResult<FiledGrievance>> {
  const s = await currentSession();
  const requestType = str(fd, "requestType");
  const category = str(fd, "category");
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "actions" });
  if (!(REQUEST_TYPES as readonly string[]).includes(requestType)) {
    return { ok: false, error: t("fixFields"), fieldErrors: { requestType: t("chooseCategory") } };
  }
  // A general complaint is routed by category (consent, content, other); rights requests need none.
  if (requestType === "complaint" && !(GRIEVANCE_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: t("fixFields"), fieldErrors: { category: t("chooseCategory") } };
  }
  return runLocalized(async () => {
    const g = await fileGrievance({
      personId: s?.personId,
      contactEmail: str(fd, "contactEmail") || s?.email || undefined,
      requestType: requestType as (typeof REQUEST_TYPES)[number],
      category: requestType === "complaint" ? (category as (typeof GRIEVANCE_CATEGORIES)[number]) : undefined,
      consentId: str(fd, "consentId") || undefined,
      subject: str(fd, "subject"),
      body: str(fd, "body"),
    });
    return { id: g.id, dueAt: g.dueAt, verificationRequired: !g.requesterVerified };
  });
}
