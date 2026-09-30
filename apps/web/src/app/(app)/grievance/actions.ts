"use server";
import { fileGrievance, GRIEVANCE_CATEGORIES } from "@cnote/compliance";
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
}

/** Public grievance filing (DPDP Act grievance redressal; IT Rules 2021 r.3(2)). Works signed-in or anonymous. */
export async function fileGrievanceAction(_prev: ActionResult<FiledGrievance> | null, fd: FormData): Promise<ActionResult<FiledGrievance>> {
  const s = await currentSession();
  const category = str(fd, "category");
  if (!(GRIEVANCE_CATEGORIES as readonly string[]).includes(category)) {
    const t = await getTranslations({ locale: await getRequestLocale(), namespace: "actions" });
    return { ok: false, error: t("fixFields"), fieldErrors: { category: t("chooseCategory") } };
  }
  return runLocalized(async () => {
    const g = await fileGrievance({
      personId: s?.personId,
      contactEmail: str(fd, "contactEmail") || s?.email || undefined,
      category: category as (typeof GRIEVANCE_CATEGORIES)[number],
      subject: str(fd, "subject"),
      body: str(fd, "body"),
    });
    return { id: g.id, dueAt: g.dueAt };
  });
}
