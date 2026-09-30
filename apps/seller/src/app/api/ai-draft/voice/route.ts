import { revalidatePath } from "next/cache";
import { errorResponse } from "@cnote/next-kit";
import { readCapped, sellerActor } from "@/features/ai-draft/route-auth";
import { logEvent } from "@/lib/metrics";
import { catalogue } from "@/lib/services";

// Raw audio body (MediaRecorder blob or an uploaded file); type in Content-Type, language in the query string.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_AUDIO = 10 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const actor = await sellerActor(req);
    const language = new URL(req.url).searchParams.get("language") ?? "en";
    const bytes = await readCapped(req, MAX_AUDIO, "Recording is larger than 10 MB");
    const started = Date.now();
    const note = await catalogue.createVoiceNote(actor.businessId, actor.personId, { bytes, mimeType: req.headers.get("content-type") ?? "" }, { language });
    const draft = await catalogue.draftListingFromVoice(actor.businessId, actor.personId, note.id, language);
    logEvent("seller.listing_drafted_from_voice", { businessId: actor.businessId, listingId: draft.listing.id, voiceNoteId: note.id, aiMs: Date.now() - started });
    revalidatePath("/listings");
    return Response.json({ ok: true, listingId: draft.listing.id, transcript: draft.transcript }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
