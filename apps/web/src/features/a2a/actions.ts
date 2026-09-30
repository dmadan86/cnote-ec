"use server";
// Buyer agent actions (ADR-020). Each re-checks the session and acts as the signed-in business; @cnote/a2a enforces the bounds again.
// Nothing here can commit a deal except confirmDealAction, which is the buyer's explicit press.
import {
  confirmNegotiation, createBuyerMandate, getMandate, pauseMandate, resumeMandate, retryRealisation, revokeMandate, setAutoAccept, updateMandate, withdrawNegotiation,
} from "@cnote/a2a";
import { actorOf, requireBusiness, type ActionResult } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseAutoOn, parseCreate, parseEdit } from "./form-parse";
import { UUID_RE } from "./labels";

/** `done` is a catalogue key so the client shows the confirmation in the buyer's language. */
export type A2aActionResult = ActionResult<{ done: string }>;
const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const fail = (fieldErrors: Record<string, string>): A2aActionResult => ({ ok: false, error: "errFix", fieldErrors });
const badId = (): A2aActionResult => ({ ok: false, error: "Not found." });
const AGENTS = "/buyer/agents";

export async function createMandateAction(_prev: A2aActionResult | null, f: FormData): Promise<A2aActionResult> {
  const s = await requireBusiness(AGENTS);
  const p = parseCreate(f);
  if (!p.ok) return fail(p.errors);
  const v = p.value;
  const r = await runLocalized(async () => {
    const m = await createBuyerMandate(actorOf(s), {
      optIn: true, name: v.name, title: v.title, requirement: v.requirement, categorySlug: v.categorySlug, quantity: v.quantity, unit: v.unit,
      targetPricePaise: v.targetPricePaise, maxPricePaise: v.limitPricePaise, maxLeadTimeDays: v.maxLeadTimeDays, approvedSellerIds: v.approvedSellerIds,
      recurrenceDays: v.recurrenceDays, expiresAt: v.expiresAt, autoAccept: v.autoAccept, autoAcceptConsent: v.autoAcceptConsent, autoAcceptLimitPaise: v.autoAcceptLimitPaise,
    });
    revalidatePath(AGENTS);
    return m.id;
  });
  if (!r.ok) return r;
  redirect(`${AGENTS}/mandates/${r.data}?done=created`);
}

export async function updateMandateAction(_prev: A2aActionResult | null, f: FormData): Promise<A2aActionResult> {
  const id = str(f, "id");
  if (!UUID_RE.test(id)) return badId();
  const s = await requireBusiness(`${AGENTS}/mandates/${id}`);
  const p = parseEdit(f);
  if (!p.ok) return fail(p.errors);
  const v = p.value;
  return runLocalized(async () => {
    await updateMandate(actorOf(s), id, {
      name: v.name, title: v.title, requirement: v.requirement, categorySlug: v.categorySlug, quantity: v.quantity, unit: v.unit,
      targetPricePaise: v.targetPricePaise, limitPricePaise: v.limitPricePaise, maxLeadTimeDays: v.maxLeadTimeDays, approvedSellerIds: v.approvedSellerIds,
      recurrenceDays: v.recurrenceDays, expiresAt: v.expiresAt,
    });
    revalidatePath(AGENTS);
    revalidatePath(`${AGENTS}/mandates/${id}`);
    return { done: "saved" };
  });
}

/** intent = pause | resume | revoke */
export async function mandateStatusAction(_prev: A2aActionResult | null, f: FormData): Promise<A2aActionResult> {
  const id = str(f, "id");
  const intent = str(f, "intent");
  if (!UUID_RE.test(id) || !["pause", "resume", "revoke"].includes(intent)) return badId();
  const s = await requireBusiness(`${AGENTS}/mandates/${id}`);
  return runLocalized(async () => {
    const a = actorOf(s);
    if (intent === "pause") await pauseMandate(a, id);
    else if (intent === "resume") await resumeMandate(a, id);
    else await revokeMandate(a, id);
    revalidatePath(AGENTS);
    revalidatePath(`${AGENTS}/mandates/${id}`);
    return { done: intent === "pause" ? "donePaused" : intent === "resume" ? "doneResumed" : "doneRevoked" };
  });
}

/** intent = off (one click, no extra fields) | on (needs consent + ceiling) */
export async function autoAcceptAction(_prev: A2aActionResult | null, f: FormData): Promise<A2aActionResult> {
  const id = str(f, "id");
  const intent = str(f, "intent");
  if (!UUID_RE.test(id) || !["on", "off"].includes(intent)) return badId();
  const s = await requireBusiness(`${AGENTS}/mandates/${id}`);
  const a = actorOf(s);
  if (intent === "off") {
    return runLocalized(async () => {
      await setAutoAccept(a, id, { enabled: false });
      revalidatePath(`${AGENTS}/mandates/${id}`);
      revalidatePath(AGENTS);
      return { done: "doneAutoOff" };
    });
  }
  const m = await getMandate(a.businessId, id);
  if (!m) return badId();
  const p = parseAutoOn(f, m.limitPricePaise);
  if (!p.ok) return fail(p.errors);
  return runLocalized(async () => {
    await setAutoAccept(a, id, { enabled: true, limitPricePaise: p.limitPricePaise, consent: true });
    revalidatePath(`${AGENTS}/mandates/${id}`);
    revalidatePath(AGENTS);
    return { done: "doneAutoOn" };
  });
}

/** intent = confirm | decline | withdraw | retry. Confirm/decline is the buyer's own decision; nothing is committed before it. */
export async function negotiationAction(_prev: A2aActionResult | null, f: FormData): Promise<A2aActionResult> {
  const id = str(f, "id");
  const intent = str(f, "intent");
  if (!UUID_RE.test(id) || !["confirm", "decline", "withdraw", "retry"].includes(intent)) return badId();
  const s = await requireBusiness(`${AGENTS}/negotiations/${id}`);
  return runLocalized(async () => {
    const a = actorOf(s);
    if (intent === "confirm" || intent === "decline") await confirmNegotiation(a, id, intent);
    else if (intent === "withdraw") await withdrawNegotiation(a, id);
    else await retryRealisation(a, id);
    revalidatePath(AGENTS);
    revalidatePath(`${AGENTS}/negotiations/${id}`);
    return { done: { confirm: "doneConfirmed", decline: "doneDeclined", withdraw: "doneWithdrawn", retry: "retried" }[intent]! };
  });
}
