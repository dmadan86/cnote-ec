// Executes the pure state machine: sends replies, provisions the seller, drafts the listing, submits it.
import { prisma } from "@cnote/db";
import type { Prisma } from "@cnote/db";
import { SELLER_APP_URL } from "./config";
import { buttonLabel, isLang, LANGUAGES, renderCopy, type Lang } from "./copy";
import { applyDrafted, applyProvisioned, applySubmitted, coerceState, transition, type Effect, type FlowState, type Input, type Transition } from "./machine";
import { sendAndRecord } from "./outbound";
import { getPorts, type WhatsAppPorts } from "./ports";
import type { WhatsAppProvider } from "./provider";
import type { MediaBytes } from "./types";

export interface FlowContext {
  contact: { id: string; language: string; state: unknown };
  /** sender wa_id (digits): transient, never persisted */
  to: string;
  now: Date;
  provider: WhatsAppProvider;
  ports?: WhatsAppPorts;
}

const money = (paise: number | null, unit: string | null) => (paise === null ? "-" : `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}${unit ? ` / ${unit}` : ""}`);

const varsFor = (s: FlowState) => {
  const seller = SELLER_APP_URL();
  return {
    businessName: s.data.businessName ?? "",
    editUrl: s.data.listingId ? `${seller}/listings/${s.data.listingId}/edit` : `${seller}/listings`,
    sellerUrl: `${seller}/listings`,
    title: s.data.draft?.title ?? "",
    category: s.data.draft?.category ?? "-",
    price: s.data.draft?.price ?? "-",
    moq: s.data.draft?.moq ?? "-",
  };
}

export async function sendReply(ctx: FlowContext, state: FlowState, e: Extract<Effect, { t: "reply" }>): Promise<void> {
  const lang = state.data.lang;
  const body = await renderCopy(e.key, lang, varsFor(state));
  const to = ctx.to;
  if (e.list === "languages") {
    const rows = (Object.keys(LANGUAGES) as Lang[]).map((l) => ({ id: `lang_${l}`, title: LANGUAGES[l] }));
    await sendAndRecord({ contactId: ctx.contact.id, kind: "interactive", body }, (p) => p.sendInteractive(to, { body, list: { button: buttonLabel("choose", lang), rows } }), ctx.provider);
  } else if (e.buttons?.length) {
    const buttons = e.buttons.map((id) => ({ id, title: buttonLabel(id, lang) }));
    await sendAndRecord({ contactId: ctx.contact.id, kind: "interactive", body }, (p) => p.sendInteractive(to, { body, buttons }), ctx.provider);
  } else {
    await sendAndRecord({ contactId: ctx.contact.id, kind: "text", body }, (p) => p.sendText(to, body), ctx.provider);
  }
}

async function save(contactId: string, state: FlowState, extra: Prisma.WhatsAppContactUpdateInput = {}) {
  await prisma.whatsAppContact.update({
    where: { id: contactId },
    data: { state: JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue, language: state.data.lang, ...(state.data.personId ? { personId: state.data.personId } : {}), ...extra },
  });
}

async function provision(ctx: FlowContext, s: FlowState, ports: WhatsAppPorts): Promise<Transition> {
  // Never provision without consent (DPDP): defence in depth on top of the state machine invariant.
  if (s.data.consent !== true || !s.data.businessName) return applyProvisioned(s, { ok: false });
  try {
    let personId = s.data.personId;
    let businessId = s.data.businessId;
    if (!personId) personId = (await ports.findOrCreatePerson(`+${ctx.to}`)).personId;
    // The first (and only) consent record exists once a Person exists (ADR-010): purpose "matching".
    await ports.recordConsent(personId, "matching", true, "whatsapp_onboarding");
    if (!businessId) {
      businessId = (await ports.createSellerBusiness(personId, { name: s.data.businessName, city: s.data.city ?? undefined, pincode: s.data.pincode, language: s.data.lang })).businessId;
    }
    return applyProvisioned(s, { ok: true, personId, businessId });
  } catch (err) {
    console.warn(`[whatsapp] provision failed: ${(err as Error).message}`);
    return applyProvisioned(s, { ok: false });
  }
}

async function draft(ctx: FlowContext, s: FlowState, ports: WhatsAppPorts): Promise<Transition> {
  try {
    if (!s.data.businessId || !s.data.personId || s.data.consent !== true) throw new Error("no business");
    const images: MediaBytes[] = [];
    let audio: MediaBytes | undefined;
    for (const m of s.data.media ?? []) {
      const bytes = await ctx.provider.downloadMedia(m.id);
      if (m.kind === "image") images.push(bytes);
      else audio = bytes;
    }
    const d = await ports.draftFromMedia(s.data.businessId, s.data.personId, { images, audio }, s.data.lang);
    return applyDrafted(s, { ok: true, listingId: d.listingId, draft: { title: d.title, category: d.categoryName, price: money(d.pricePaise, d.priceUnit), moq: d.moq ? `${d.moq}${d.moqUnit ? ` ${d.moqUnit}` : ""}` : "-" } });
  } catch (err) {
    console.warn(`[whatsapp] draft failed: ${(err as Error).message}`);
    return applyDrafted(s, { ok: false });
  }
}

async function submit(s: FlowState, ports: WhatsAppPorts): Promise<Transition> {
  try {
    if (!s.data.businessId || !s.data.listingId) throw new Error("no listing");
    await ports.submitListing(s.data.businessId, s.data.listingId);
    return applySubmitted(s, { ok: true });
  } catch (err) {
    console.warn(`[whatsapp] submit failed: ${(err as Error).message}`);
    return applySubmitted(s, { ok: false });
  }
}

/** Runs one inbound message through the conversation. Reply failures never throw (recorded as failed rows). */
export async function runFlow(ctx: FlowContext, input: Input): Promise<FlowState> {
  const ports = ctx.ports ?? getPorts();
  const lang: Lang = isLang(ctx.contact.language) ? ctx.contact.language : "en";
  let t = transition(coerceState(ctx.contact.state, lang), input, ctx.now);
  let state = t.state;
  await save(ctx.contact.id, state);
  let queue: Effect[] = [...t.effects];
  for (let guard = 0; queue.length && guard < 20; guard++) {
    const e = queue.shift()!;
    if (e.t === "reply") await sendReply(ctx, state, e);
    else if (e.t === "setLanguage") await save(ctx.contact.id, state);
    else {
      const r = e.t === "provision" ? await provision(ctx, state, ports) : e.t === "draft" ? await draft(ctx, state, ports) : await submit(state, ports);
      state = r.state;
      await save(ctx.contact.id, state);
      queue = [...r.effects, ...queue];
    }
  }
  return state;
}
