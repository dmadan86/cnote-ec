import "server-only";
// Seller-side dispute intents (ADR-013), shared by the server action (text-only) and the multipart route handler (app/api/disputes/route.ts).
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actorOf, type SessionWithBusiness } from "@cnote/next-kit";
import {
  addDisputeEvidence, appealDecision, escalateDispute, MAX_EVIDENCE_BYTES, MAX_EVIDENCE_FILES, postDisputeMessage, respondToDispute, withdrawDispute,
  type EvidenceUpload, type Lang,
} from "@/lib/disputes";

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

export const disputeIdOf = (fd: FormData) => String(fd.get("disputeId") ?? "");

/** `withFiles` is true only on the upload route, which has its own body cap; the server action (2 MB cap) refuses files outright. */
export async function runDisputeIntent(fd: FormData, session: SessionWithBusiness, opts: { withFiles?: boolean } = {}): Promise<null> {
  const id = disputeIdOf(fd);
  const intent = String(fd.get("intent") ?? "");
  const t = await getTranslations("disputes");
  const actor = actorOf(session);
  const text = String(fd.get("text") ?? "");
  const language = (LANGS.includes(String(fd.get("language"))) ? String(fd.get("language")) : "en") as Lang;
  const voiceConsent = fd.get("voiceConsent") === "on";
  const files = await uploads(fd);
  if (files.length && !opts.withFiles) throw new Error("Evidence files must be uploaded through the upload endpoint, not a plain form post.");
  if (intent === "respond") await respondToDispute(actor, id, { text, language, voiceConsent, attachments: files });
  else if (intent === "evidence") {
    if (files.length > 1) throw new Error(t("oneFileAtATime"));
    await addDisputeEvidence(actor, id, { text, language, voiceConsent, attachment: files[0] });
  } else if (intent === "escalate") await escalateDispute(actor, id);
  else if (intent === "withdraw") await withdrawDispute(actor, id);
  else if (intent === "appeal") await appealDecision(actor, id, text);
  else if (intent === "message") await postDisputeMessage(actor, id, text);
  else throw new Error(t("invalidAction"));
  revalidatePath(`/disputes/${id}`);
  revalidatePath("/disputes");
  return null;
}
