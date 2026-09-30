"use server";
// Seller-side dispute actions (ADR-013): respond, add evidence, message staff, escalate an auto-decision, appeal, withdraw.
import { revalidatePath } from "next/cache";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import {
  addDisputeEvidence, appealDecision, escalateDispute, postDisputeMessage, respondToDispute, withdrawDispute, type EvidenceUpload, type Lang,
} from "@/lib/disputes";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";

export type DisputeResult = ActionResult<null>;
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

export async function disputeAction(_prev: DisputeResult | null, fd: FormData): Promise<DisputeResult> {
  const id = String(fd.get("disputeId") ?? "");
  const intent = String(fd.get("intent") ?? "");
  const session = await requireSeller(`/disputes/${id}`);
  const actor = actorOf(session);
  const text = String(fd.get("text") ?? "");
  const language = (LANGS.includes(String(fd.get("language"))) ? String(fd.get("language")) : "en") as Lang;
  const voiceConsent = fd.get("voiceConsent") === "on";
  return run(async () => {
    if (intent === "respond") await respondToDispute(actor, id, { text, language, voiceConsent, attachments: await uploads(fd) });
    else if (intent === "evidence") {
      const files = await uploads(fd);
      if (files.length > 1) throw new Error("Add one file at a time.");
      await addDisputeEvidence(actor, id, { text, language, voiceConsent, attachment: files[0] });
    } else if (intent === "escalate") await escalateDispute(actor, id);
    else if (intent === "withdraw") await withdrawDispute(actor, id);
    else if (intent === "appeal") await appealDecision(actor, id, text);
    else if (intent === "message") await postDisputeMessage(actor, id, text);
    else throw new Error("invalid action");
    revalidatePath(`/disputes/${id}`);
    revalidatePath("/disputes");
    return null;
  });
}
