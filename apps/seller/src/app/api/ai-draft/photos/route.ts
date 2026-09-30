import { revalidatePath } from "next/cache";
import { DomainError } from "@cnote/core";
import { errorResponse } from "@cnote/next-kit";
import { assertDeclaredSize, sellerActor } from "@/features/ai-draft/route-auth";
import { logEvent } from "@/lib/metrics";
import { catalogue } from "@/lib/services";

// Multipart upload of 1-4 photos (5 MB each => up to ~20 MB). The proxy body limit is raised in next.config.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BODY = 21 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const actor = await sellerActor(req);
    assertDeclaredSize(req, MAX_BODY, "Photos are larger than 20 MB in total");
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
    if (files.length < 1 || files.length > 4) throw new DomainError("validation", "Add 1 to 4 photos");
    const started = Date.now();
    const draft = await catalogue.draftListingFromPhotos(actor.businessId, actor.personId, {
      files: await Promise.all(files.map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), filename: f.name }))),
      hintText: String(form.get("hint") ?? "").slice(0, 2000) || undefined,
      language: String(form.get("language") ?? "en"),
    });
    logEvent("seller.listing_drafted_from_photos", { businessId: actor.businessId, listingId: draft.listing.id, photos: draft.images.length, needsReview: draft.ai.needsReview, aiMs: Date.now() - started });
    revalidatePath("/listings");
    return Response.json({ ok: true, listingId: draft.listing.id, needsReview: draft.ai.needsReview, skipped: draft.skipped }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
