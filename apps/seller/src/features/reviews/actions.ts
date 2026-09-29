"use server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { replyToComment, replyToReview } from "@cnote/reviews";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";

export type ReplyResult = ActionResult<null>;

const fields = z.object({ id: z.uuid(), kind: z.enum(["review", "comment"]), body: z.string().trim().min(2, "Write your reply first.").max(1000, "Keep replies under 1,000 characters.") });

/** Replies are held for staff approval (per ADR-008/010) before they appear publicly. */
export async function replyAction(_prev: ReplyResult | null, fd: FormData): Promise<ReplyResult> {
  const session = await requireSeller("/reviews");
  return run(async () => {
    const { id, kind, body } = fields.parse({ id: str(fd, "id"), kind: str(fd, "kind"), body: str(fd, "body") });
    const actor = actorOf(session);
    if (kind === "review") await replyToReview(actor, id, body);
    else await replyToComment(actor, id, body);
    revalidatePath("/reviews");
    return null;
  });
}
