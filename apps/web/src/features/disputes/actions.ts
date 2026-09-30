"use server";
// Buyer-side dispute actions (ADR-013). One action, several intents. Each re-checks the session: server actions are reachable by direct POST.
import {
  addDisputeEvidence, appealDecision, escalateDispute, openDispute, postDisputeMessage, respondToDispute, withdrawDispute,
  type EvidenceUpload, type Lang,
} from "@/lib/disputes";
import { actorOf, requireBusiness, runAction, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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

export async function disputeAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const intent = String(f.get("intent") ?? "");
  const id = String(f.get("disputeId") ?? "");
  const orderId = String(f.get("orderId") ?? "");
  const s = await requireBusiness(id ? `/buyer/disputes/${id}` : `/buyer/orders/${orderId}`);
  const actor = actorOf(s);
  const lang = LANGS.includes(String(f.get("language"))) ? (String(f.get("language")) as Lang) : "en";
  const text = String(f.get("text") ?? "");
  const voiceConsent = f.get("voiceConsent") === "on";
  let created: string | null = null;
  const r = await runAction(async () => {
    if (intent === "open") {
      const rupees = String(f.get("amountRupees") ?? "").trim();
      const d = await openDispute(actor, {
        orderId, type: String(f.get("type")) as never, description: text, language: lang, voiceConsent, attachments: await uploads(f),
        amountPaise: rupees === "" ? null : Math.round(Number(rupees) * 100),
      });
      created = d.id;
    } else if (intent === "respond") await respondToDispute(actor, id, { text, language: lang, voiceConsent, attachments: await uploads(f) });
    else if (intent === "evidence") {
      const files = await uploads(f);
      if (files.length > 1) throw new Error("Add one file at a time.");
      await addDisputeEvidence(actor, id, { text, language: lang, voiceConsent, attachment: files[0] });
    } else if (intent === "withdraw") await withdrawDispute(actor, id);
    else if (intent === "escalate") await escalateDispute(actor, id);
    else if (intent === "appeal") await appealDecision(actor, id, text);
    else if (intent === "message") await postDisputeMessage(actor, id, text);
    else throw new Error("invalid action");
  });
  if (r.ok) {
    revalidatePath("/buyer/orders");
    if (id) revalidatePath(`/buyer/disputes/${id}`);
    if (created) redirect(`/buyer/disputes/${created}`);
  }
  return r;
}
