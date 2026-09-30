"use server";
import { APPEAL_SUBJECT_TYPES, fileAppeal, type AppealSubjectType } from "@cnote/compliance";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";

export type AppealResult = ActionResult<null>;

const fields = (t: (key: "reasonMin" | "reasonMax") => string) =>
  z.object({
    subjectType: z.enum(APPEAL_SUBJECT_TYPES),
    subjectId: z.uuid(),
    reason: z.string().trim().min(10, t("reasonMin")).max(2000, t("reasonMax")),
  });

/** Appeal a rejection (ADR-010). Ownership and "was rejected" are verified server-side by @cnote/compliance. */
export async function fileAppealAction(_prev: AppealResult | null, fd: FormData): Promise<AppealResult> {
  const session = await requireSeller("/appeals");
  const t = await getTranslations("appeals.errors");
  return run(async () => {
    const input = fields(t).parse({ subjectType: str(fd, "subjectType"), subjectId: str(fd, "subjectId"), reason: str(fd, "reason") });
    await fileAppeal(actorOf(session), input as { subjectType: AppealSubjectType; subjectId: string; reason: string });
    revalidatePath("/appeals");
    return null;
  });
}
