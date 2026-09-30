"use server";
import { fileGrievance, GRIEVANCE_CATEGORIES } from "@cnote/compliance";
import { currentSession, runAction, type ActionResult } from "@cnote/next-kit";

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
  if (!(GRIEVANCE_CATEGORIES as readonly string[]).includes(category)) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: { category: "Choose a category" } };
  return runAction(async () => {
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
