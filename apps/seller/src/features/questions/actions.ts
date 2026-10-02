"use server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { answerQuestion } from "@cnote/reviews";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";

export type AnswerResult = ActionResult<{ stripped: boolean }>;

/**
 * Answers (or edits the answer to) a buyer's product question. The module strips contact details and screens the text;
 * the answer is public only once approved, and the buyer is notified through the notification pipeline.
 */
export async function answerQuestionAction(_prev: AnswerResult | null, fd: FormData): Promise<AnswerResult> {
  const session = await requireSeller("/questions");
  const t = await getTranslations("questions");
  const fields = z.object({ id: z.uuid(), body: z.string().trim().min(2, t("errWrite")).max(1000, t("errLong")) });
  return run(async () => {
    const { id, body } = fields.parse({ id: str(fd, "id"), body: str(fd, "body") });
    const res = await answerQuestion(actorOf(session), id, { body });
    revalidatePath("/questions");
    return { stripped: res.piiStripped };
  });
}
