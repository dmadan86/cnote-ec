"use server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { replyToComment, replyToReview } from "@cnote/reviews";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";

export type ReplyResult = ActionResult<null>;

/** Replies are held for staff approval (per ADR-008/010) before they appear publicly. */
export async function replyAction(_prev: ReplyResult | null, fd: FormData): Promise<ReplyResult> {
  const session = await requireSeller("/reviews");
  const t = await getTranslations("reviews");
  const fields = z.object({ id: z.uuid(), kind: z.enum(["review", "comment"]), body: z.string().trim().min(2, t("errWrite")).max(1000, t("errLong")) });
  return run(async () => {
    const { id, kind, body } = fields.parse({ id: str(fd, "id"), kind: str(fd, "kind"), body: str(fd, "body") });
    const actor = actorOf(session);
    if (kind === "review") await replyToReview(actor, id, body);
    else await replyToComment(actor, id, body);
    revalidatePath("/reviews");
    return null;
  });
}
