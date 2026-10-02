import "server-only";
// Buyer-side dispute intents (ADR-013), shared by the server action (text-only) and the multipart route handler (app/api/disputes/route.ts).
import {
  addDisputeEvidence, appealDecision, escalateDispute, MAX_EVIDENCE_BYTES, MAX_EVIDENCE_FILES, openDispute, postDisputeMessage, respondToDispute, withdrawDispute,
  type EvidenceUpload, type Lang,
} from "@/lib/disputes";
import { actorOf, type SessionWithBusiness } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

/** Whole-request cap for the upload route: every allowed evidence file at full size plus form fields and multipart framing. */
export const DISPUTE_UPLOAD_MAX_BYTES = MAX_EVIDENCE_FILES * MAX_EVIDENCE_BYTES + 512 * 1024;

const LANGS: readonly string[] = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"];

async function uploads(f: FormData): Promise<EvidenceUpload[]> {
  const out: EvidenceUpload[] = [];
  for (const [field, kind] of [["photos", "photo"], ["documents", "document"], ["voice", "voice"]] as const) {
    for (const v of f.getAll(field)) {
      if (typeof v === "string" || v.size === 0) continue;
      out.push({ kind, bytes: new Uint8Array(await v.arrayBuffer()), mimeType: v.type });
    }
  }
  return out;
}

/** The page the caller should be sent back to when the session is missing. */
export const disputeReturnTo = (f: FormData) => {
  const id = String(f.get("disputeId") ?? "");
  return id ? `/buyer/disputes/${id}` : `/buyer/orders/${String(f.get("orderId") ?? "")}`;
};

/** Runs one intent. Returns the id of a newly opened dispute (the caller redirects there). `withFiles` is true only on the upload route. */
export async function runDisputeIntent(f: FormData, s: SessionWithBusiness, opts: { withFiles?: boolean } = {}): Promise<{ created: string | null }> {
  const intent = String(f.get("intent") ?? "");
  const id = String(f.get("disputeId") ?? "");
  const orderId = String(f.get("orderId") ?? "");
  const actor = actorOf(s);
  const lang = LANGS.includes(String(f.get("language"))) ? (String(f.get("language")) as Lang) : "en";
  const text = String(f.get("text") ?? "");
  const voiceConsent = f.get("voiceConsent") === "on";
  const files = await uploads(f);
  if (files.length && !opts.withFiles) throw new Error("Evidence files must be uploaded through the upload endpoint, not a plain form post.");
  let created: string | null = null;
  if (intent === "open") {
    const rupees = String(f.get("amountRupees") ?? "").trim();
    const d = await openDispute(actor, {
      orderId, type: String(f.get("type")) as never, description: text, language: lang, voiceConsent, attachments: files,
      amountPaise: rupees === "" ? null : Math.round(Number(rupees) * 100),
    });
    created = d.id;
  } else if (intent === "respond") await respondToDispute(actor, id, { text, language: lang, voiceConsent, attachments: files });
  else if (intent === "evidence") {
    if (files.length > 1) throw new Error("Add one file at a time.");
    await addDisputeEvidence(actor, id, { text, language: lang, voiceConsent, attachment: files[0] });
  } else if (intent === "withdraw") await withdrawDispute(actor, id);
  else if (intent === "escalate") await escalateDispute(actor, id);
  else if (intent === "appeal") await appealDecision(actor, id, text);
  else if (intent === "message") await postDisputeMessage(actor, id, text);
  else throw new Error("invalid action");
  revalidatePath("/buyer/orders");
  if (id) revalidatePath(`/buyer/disputes/${id}`);
  return { created };
}
