"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { getImageForModeration, moderateListingImage } from "@cnote/catalogue";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";
import { IMAGES_MODERATE } from "./privilege";

const decisionSchema = z.object({
  id: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

/** Approve / reject one image. Privilege is enforced server-side (again inside audited()); rejection needs a note. */
export async function moderateImageAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = decisionSchema.parse({ id: fd.get("id"), decision: fd.get("decision"), note: fd.get("note") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, IMAGES_MODERATE);
    await decide(ctx, input.id, input.decision, input.note);
  });
  if (result.ok) {
    revalidatePath("/images");
    revalidatePath(`/images/${String(fd.get("id"))}`);
  }
  return result;
}

/** Approve every selected image (each is its own audited action). Reports how many succeeded. */
export async function bulkApproveImagesAction(_prev: ActionResult<{ approved: number; failed: number }> | null, fd: FormData): Promise<ActionResult<{ approved: number; failed: number }>> {
  const result = await runAction(async () => {
    const ids = z.array(z.uuid()).min(1, "Select at least one image.").max(100).parse([...new Set(fd.getAll("ids").map(String))]);
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, IMAGES_MODERATE);
    let approved = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await decide(ctx, id, "approved", undefined, true);
        approved++;
      } catch (err) {
        console.error("[admin] bulk image approve failed", id, err instanceof Error ? err.message : err);
        failed++;
      }
    }
    return { approved, failed };
  });
  if (result.ok) revalidatePath("/images");
  return result;
}

async function decide(ctx: Awaited<ReturnType<typeof actionContext>>, id: string, decision: "approved" | "rejected", note: string | undefined, bulk = false) {
  // Read first so the audit row records what was decided on (never trust client-supplied context).
  const before = await getImageForModeration(id);
  const short = decision === "approved" ? "approve" : "reject";
  // audited() writes this same object after fn resolves, so before/after can be attached from inside fn.
  const details: Record<string, unknown> = { decision, note: note ?? null, bulk, listingId: before?.listingId ?? null, sellerBusinessId: before?.sellerBusinessId ?? null, fromStatus: before?.status ?? null };
  await audited(
    ctx,
    IMAGES_MODERATE,
    `listing_image.${short}`,
    { type: "listing_image", id },
    async () => {
      const r = await moderateListingImage(id, decision, note, ctx.staff.id);
      Object.assign(details, { before: r.before, after: r.after });
    },
    details,
  );
}
