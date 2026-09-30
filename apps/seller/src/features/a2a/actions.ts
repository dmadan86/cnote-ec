"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import {
  confirmNegotiation, createSellerMandate, pauseMandate, resumeMandate, retryRealisation, revokeMandate, setAutoAccept, updateMandate, withdrawNegotiation,
  type MandatePatch,
} from "@cnote/a2a";
import { requireSeller } from "@/lib/auth";
import { numOrNull, str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { rupeesToPaiseExact } from "./money";

export type AgentResult = ActionResult<null>;

const zerr = (path: string, message: string) => new z.ZodError([{ code: "custom", path: [path], message, input: null }]);
type ErrT = Awaited<ReturnType<typeof getTranslations>>;

/** Rupees field -> integer paise. Empty -> null when optional. */
function money(fd: FormData, key: string, label: string, t: ErrT, required = false): number | null {
  const raw = str(fd, key);
  if (raw === "") {
    if (required) throw zerr(key, t("enterRupees", { label }));
    return null;
  }
  const p = rupeesToPaiseExact(raw);
  if (p === null) throw zerr(key, t("enterRupees", { label }));
  return p;
}
const intOrNull = (fd: FormData, key: string, label: string, t: ErrT): number | null => {
  const n = numOrNull(fd, key);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw zerr(key, t("enterWhole", { label }));
  return n;
};
/** yyyy-mm-dd -> end of that day in IST. */
const endOfDayIst = (d: string): string => `${d}T23:59:59+05:30`;
const dateOrNull = (fd: FormData, key: string, t: ErrT): string | null => {
  const v = str(fd, key);
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw zerr(key, t("enterDate"));
  return endOfDayIst(v);
};

const revalidate = (id?: string) => {
  revalidatePath("/agents");
  if (id) revalidatePath(`/agents/mandates/${id}`);
};

/** New quoting mandate. Explicit opt-in is required; auto-accept starts OFF (ADR-020) and is switched on later, on its own. */
export async function createMandateAction(_prev: AgentResult | null, fd: FormData): Promise<AgentResult> {
  const session = await requireSeller("/agents");
  const t = await getTranslations("a2a.errors");
  let createdId: string | null = null;
  const res = await run(async () => {
    if (fd.get("optIn") !== "on") throw zerr("optIn", t("optInRequired"));
    const m = await createSellerMandate(actorOf(session), {
      optIn: true,
      name: str(fd, "name"),
      priceBookId: str(fd, "priceBookId") || null,
      floorPricePaise: money(fd, "floor", t("labelFloor"), t),
      maxDiscountPct: intOrNull(fd, "maxDiscountPct", t("labelDiscount"), t),
      capacityQty: intOrNull(fd, "capacityQty", t("labelCapacity"), t),
      maxRounds: intOrNull(fd, "maxRounds", t("labelRounds"), t) ?? 6,
      expiresAt: dateOrNull(fd, "expiresAt", t),
      deliveryTerms: str(fd, "deliveryTerms") || null,
      paymentTerms: str(fd, "paymentTerms") || null,
      autoAccept: false,
    });
    createdId = m.id;
    logEvent("seller.agent_mandate_created", { businessId: session.business.id });
    revalidate();
    return null;
  });
  if (res.ok && createdId) redirect(`/agents/mandates/${createdId}`);
  return res;
}

/** Edit limits and terms. Running negotiations keep the limits they started with. */
export async function updateMandateAction(_prev: AgentResult | null, fd: FormData): Promise<AgentResult> {
  const id = str(fd, "id");
  const session = await requireSeller(`/agents/mandates/${id}`);
  const t = await getTranslations("a2a.errors");
  return run(async () => {
    const patch: MandatePatch = {
      name: str(fd, "name"),
      priceBookId: str(fd, "priceBookId") || null,
      limitPricePaise: money(fd, "floor", t("labelFloor"), t),
      maxDiscountPct: intOrNull(fd, "maxDiscountPct", t("labelDiscount"), t),
      capacityQty: intOrNull(fd, "capacityQty", t("labelCapacity"), t),
      maxRounds: intOrNull(fd, "maxRounds", t("labelRounds"), t) ?? 6,
      deliveryTerms: str(fd, "deliveryTerms") || null,
      paymentTerms: str(fd, "paymentTerms") || null,
    };
    // Only send the expiry when it changed (an unchanged past expiry would be rejected as "not in the future").
    const expiry = str(fd, "expiresAt");
    if (expiry !== str(fd, "expiresAtInitial")) patch.expiresAt = dateOrNull(fd, "expiresAt", t);
    await updateMandate(actorOf(session), id, patch);
    revalidate(id);
    return null;
  });
}

/** Auto-accept: turning it ON needs the consent box and a minimum price; turning it OFF is one click. */
export async function setAutoAcceptAction(_prev: AgentResult | null, fd: FormData): Promise<AgentResult> {
  const id = str(fd, "id");
  const session = await requireSeller(`/agents/mandates/${id}`);
  const t = await getTranslations("a2a.errors");
  return run(async () => {
    const enabled = str(fd, "enabled") === "on";
    if (enabled) {
      if (fd.get("consent") !== "on") throw zerr("consent", t("consentRequired"));
      await setAutoAccept(actorOf(session), id, { enabled: true, limitPricePaise: money(fd, "limit", t("labelAutoMin"), t, true), consent: true });
    } else {
      await setAutoAccept(actorOf(session), id, { enabled: false });
    }
    logEvent("seller.agent_auto_accept", { businessId: session.business.id, enabled });
    revalidate(id);
    return null;
  });
}

const statusIntent = z.enum(["pause", "resume", "revoke"]);
export async function mandateStatusAction(_prev: AgentResult | null, fd: FormData): Promise<AgentResult> {
  const id = str(fd, "id");
  const session = await requireSeller(`/agents/mandates/${id}`);
  return run(async () => {
    const intent = statusIntent.parse(str(fd, "intent"));
    const actor = actorOf(session);
    if (intent === "pause") await pauseMandate(actor, id);
    else if (intent === "resume") await resumeMandate(actor, id);
    else await revokeMandate(actor, id);
    revalidate(id);
    return null;
  });
}

const negIntent = z.enum(["confirm", "decline", "withdraw", "retry"]);
/** The principal's decision. Nothing is committed until the seller confirms (or auto-accept applied within their own bounds). */
export async function negotiationDecisionAction(_prev: AgentResult | null, fd: FormData): Promise<AgentResult> {
  const id = str(fd, "id");
  const session = await requireSeller(`/agents/negotiations/${id}`);
  return run(async () => {
    const intent = negIntent.parse(str(fd, "intent"));
    const actor = actorOf(session);
    if (intent === "confirm" || intent === "decline") await confirmNegotiation(actor, id, intent);
    else if (intent === "withdraw") await withdrawNegotiation(actor, id);
    else await retryRealisation(actor, id);
    logEvent("seller.agent_negotiation_decision", { businessId: session.business.id, intent });
    revalidatePath("/agents");
    revalidatePath(`/agents/negotiations/${id}`);
    return null;
  });
}
