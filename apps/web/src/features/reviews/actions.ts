"use server";
// Buyer-side UGC actions. Each re-checks the session (server actions are reachable by direct POST).
// Everything submitted is held for staff moderation; nothing here publishes content.
import { type ActionResult, currentSession, runAction } from "@cnote/next-kit";
import { react, submitComment, submitReview } from "@cnote/reviews";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const uuid = z.uuid();
const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

async function actor() {
  const s = await currentSession();
  if (!s) return null;
  return { personId: s.personId, businessId: s.business?.id ?? null, language: s.preferredLanguage };
}
const SIGN_IN = { ok: false, error: "Please sign in to continue." } as const;

export async function submitReviewAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const a = await actor();
  if (!a) return SIGN_IN;
  const listingId = str(f, "listingId");
  const result = await runAction(async () => {
    await submitReview(a, uuid.parse(listingId), {
      rating: Number(f.get("rating") || 0),
      title: str(f, "title") || undefined,
      body: str(f, "body"),
      language: a.language,
    });
  });
  if (result.ok) revalidatePath(`/products/${listingId}`);
  return result;
}

export async function submitCommentAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const a = await actor();
  if (!a) return SIGN_IN;
  const listingId = str(f, "listingId");
  const result = await runAction(async () => {
    await submitComment(a, uuid.parse(listingId), { body: str(f, "body"), language: a.language });
  });
  if (result.ok) revalidatePath(`/products/${listingId}`);
  return result;
}

/** "helpful" or "report" on a review or a comment. Repeats are harmless no-ops. */
export async function reactAction(_prev: ActionResult<{ changed: boolean }> | null, f: FormData): Promise<ActionResult<{ changed: boolean }>> {
  const a = await actor();
  if (!a) return SIGN_IN;
  const listingId = str(f, "listingId");
  const result = await runAction(() =>
    react(a, {
      subjectType: z.enum(["review", "comment"]).parse(str(f, "subjectType")),
      subjectId: uuid.parse(str(f, "subjectId")),
      kind: z.enum(["helpful", "report"]).parse(str(f, "kind")),
      reason: str(f, "reason") || undefined,
    }),
  );
  if (result.ok && result.data.changed) revalidatePath(`/products/${listingId}`);
  return result;
}
