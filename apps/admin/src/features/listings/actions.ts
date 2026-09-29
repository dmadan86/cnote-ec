"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { getVersionForReview, reviewListingVersion } from "@cnote/catalogue";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({
  versionId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Approve / reject a submitted listing version. Approval does not publish: it emits ListingVersionReviewed and the
 * publisher (worker) projects the version into the live database. Rejection needs a note the seller will see.
 */
export async function reviewVersionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ versionId: fd.get("versionId"), decision: fd.get("decision"), note: fd.get("note") || undefined });
    if (input.decision === "rejected" && !input.note) throw new z.ZodError([{ code: "custom", path: ["note"], message: "A note is required to reject.", input: undefined }]);
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "listings.moderate");
    const before = await getVersionForReview(input.versionId); // record what was decided on, never client-supplied context
    const short = input.decision === "approved" ? "approve" : "reject";
    await audited(
      ctx,
      "listings.moderate",
      `listing_version.${short}`,
      { type: "listing_version", id: input.versionId },
      async () => void (await reviewListingVersion(input.versionId, input.decision, input.note, ctx.staff.id)),
      { decision: input.decision, note: input.note ?? null, listingId: before?.version.listingId ?? null, version: before?.version.version ?? null, aiVerdict: before?.version.aiVerdict ?? null, changes: before?.changes.map((c) => c.field) ?? [] },
    );
  });
  if (result.ok) {
    revalidatePath("/listings");
    revalidatePath(`/listings/${String(fd.get("versionId"))}`);
  }
  return result;
}
