import "server-only";
// Buyer-side sample intents (docs/design/samples.md), shared by the server action (text-only) and the multipart route handler
// (app/api/samples/route.ts, evaluation photos).
import {
  acceptLinkedQuote, cancelSample, evaluateSample, markSampleDelivered, MAX_EVALUATION_PHOTOS, MAX_PHOTO_BYTES, requestSample, REJECT_REASONS,
  type PhotoUpload, type RejectReason,
} from "@/lib/samples";
import { actorOf, type SessionWithBusiness } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

/** Whole-request cap for the upload route: every allowed photo at full size plus form fields and multipart framing. */
export const SAMPLE_UPLOAD_MAX_BYTES = MAX_EVALUATION_PHOTOS * MAX_PHOTO_BYTES + 512 * 1024;

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

async function photos(f: FormData): Promise<PhotoUpload[]> {
  const out: PhotoUpload[] = [];
  for (const v of f.getAll("photos")) {
    if (typeof v === "string" || v.size === 0) continue; // an empty file input submits one zero-byte entry
    out.push({ bytes: new Uint8Array(await v.arrayBuffer()), mimeType: v.type });
  }
  return out;
}

/** Where the caller should be sent back to when the session is missing. */
export const sampleReturnTo = (f: FormData) => {
  const id = String(f.get("sampleId") ?? "");
  if (id) return `/buyer/samples/${id}`;
  const listing = String(f.get("listingId") ?? "");
  const conv = String(f.get("conversationId") ?? "");
  return listing ? `/buyer/samples/new?listing=${encodeURIComponent(listing)}` : conv ? `/buyer/samples/new?conversation=${encodeURIComponent(conv)}` : "/buyer/samples";
};

/** Runs one intent. Returns the id of a newly created request (the caller redirects there). `withFiles` is true only on the upload route. */
export async function runSampleIntent(f: FormData, s: SessionWithBusiness, opts: { withFiles?: boolean } = {}): Promise<{ created: string | null }> {
  const intent = String(f.get("intent") ?? "");
  const id = String(f.get("sampleId") ?? "");
  const actor = actorOf(s);
  const files = await photos(f);
  if (files.length && !opts.withFiles) throw new Error("Photos must be uploaded through the upload endpoint, not a plain form post.");
  let created: string | null = null;
  if (intent === "request") {
    const qty = Number(String(f.get("quantity") ?? ""));
    const v = await requestSample(actor, {
      listingId: str(f, "listingId"), conversationId: str(f, "conversationId"), quoteId: str(f, "quoteId") ?? null,
      quantity: Number.isFinite(qty) ? qty : 0, note: str(f, "note") ?? null, language: s.preferredLanguage ?? "en",
      shipTo: { name: str(f, "name") ?? "", phone: str(f, "phone") ?? null, line1: str(f, "line1") ?? "", line2: str(f, "line2") ?? null, city: str(f, "city") ?? "", pincode: str(f, "pincode") ?? "" },
    });
    created = v.id;
  } else if (intent === "cancel") await cancelSample(actor, id);
  else if (intent === "received") await markSampleDelivered(actor, id);
  else if (intent === "acceptQuote") await acceptLinkedQuote(actor, id);
  else if (intent === "evaluate") {
    const approved = f.get("verdict") === "approve";
    const reasons = f.getAll("reasons").map(String).filter((r): r is RejectReason => (REJECT_REASONS as readonly string[]).includes(r));
    await evaluateSample(actor, id, { approved, reasons: approved ? [] : reasons, notes: str(f, "notes") ?? null, photos: files });
  } else throw new Error("invalid action");
  revalidatePath("/buyer/samples");
  if (id) revalidatePath(`/buyer/samples/${id}`);
  return { created };
}
