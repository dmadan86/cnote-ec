// Outbound messaging: records every send, respects opt-out and the 24h window, retries transient provider errors.
import { redactPii } from "@cnote/ai";
import { prisma } from "@cnote/db";
import { hashPhone } from "@cnote/identity";
import { TEMPLATE_COST_PAISE, type TemplateCategory } from "./config";
import { getWhatsAppProvider, WhatsAppError, type WhatsAppProvider } from "./provider";
import type { InteractiveMessage, TemplateMessage } from "./types";
import { isWithinWindow } from "./window";

export interface OutboundRecord {
  contactId: string;
  kind: "text" | "template" | "interactive";
  body: string;
  template?: string;
  category?: TemplateCategory;
}

/** E.164; bare 10-digit Indian mobiles get +91. */
export function toE164(raw: string): string {
  const s = raw.replace(/[\s\-().]/g, "");
  const p = /^[6-9]\d{9}$/.test(s) ? `+91${s}` : s.startsWith("00") ? `+${s.slice(2)}` : s;
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw new Error("Invalid phone number");
  return p;
}

const short = (s: string) => redactPii(s).slice(0, 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends with up to 2 inline retries on transient errors, then records the row as sent or failed. Never throws. */
export async function sendAndRecord(
  rec: OutboundRecord,
  send: (p: WhatsAppProvider) => Promise<{ providerId: string }>,
  provider: WhatsAppProvider = getWhatsAppProvider(),
): Promise<{ ok: boolean; providerId?: string; error?: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { providerId } = await send(provider);
      await prisma.whatsAppMessage.create({
        data: {
          contactId: rec.contactId, direction: "out", providerId, kind: rec.kind, body: short(rec.body), template: rec.template ?? null, status: "sent",
          costPaise: rec.category ? TEMPLATE_COST_PAISE[rec.category] : 0,
        },
      });
      return { ok: true, providerId };
    } catch (e) {
      lastErr = e;
      if (e instanceof WhatsAppError && e.permanent) break;
      if (attempt < 3) await sleep(150 * attempt);
    }
  }
  const error = lastErr instanceof WhatsAppError ? `${lastErr.status}${lastErr.code ? `/${lastErr.code}` : ""}` : "error";
  await prisma.whatsAppMessage.create({
    data: { contactId: rec.contactId, direction: "out", kind: rec.kind, body: short(rec.body), template: rec.template ?? null, status: "failed" },
  });
  console.warn(`[whatsapp] outbound ${rec.kind} failed (${error})`);
  return { ok: false, error };
}

export type OutboundOutcome = { sent: true; via: "text" | "interactive" | "template"; providerId: string } | { sent: false; reason: "opted_out" | "outside_window" | "no_consent" | "send_failed" };

export interface OutboundRequest {
  /** E.164 (+91...) or a bare 10-digit Indian mobile */
  phone: string;
  /** free-form text: only used inside the 24h window */
  text?: string;
  interactive?: InteractiveMessage;
  /** Meta-approved template, used when the window is closed (or when there is no text) */
  template?: TemplateMessage & { category: TemplateCategory };
  /** required for marketing-category templates: the recipient's marketing consent (ADR-010) */
  marketingConsent?: boolean;
  now?: Date;
}

/**
 * Helper for other modules (lead notifications, reminders). Opted-out contacts are never messaged. Inside the 24h
 * window free-form text is used (cheapest); outside it only an approved template can be sent.
 */
export async function sendToPhone(req: OutboundRequest, provider: WhatsAppProvider = getWhatsAppProvider()): Promise<OutboundOutcome> {
  const phone = toE164(req.phone);
  const now = req.now ?? new Date();
  const contact = await prisma.whatsAppContact.upsert({ where: { phoneHash: hashPhone(phone) }, create: { phoneHash: hashPhone(phone) }, update: {} });
  if (contact.optedOutAt) return { sent: false, reason: "opted_out" };
  const to = phone.slice(1);
  const freeForm = req.text ?? req.interactive?.body;
  if (freeForm && isWithinWindow(contact.windowUntil, now)) {
    const r = await sendAndRecord(
      { contactId: contact.id, kind: req.interactive ? "interactive" : "text", body: freeForm },
      (p) => (req.interactive ? p.sendInteractive(to, req.interactive) : p.sendText(to, req.text!)),
      provider,
    );
    return r.ok ? { sent: true, via: req.interactive ? "interactive" : "text", providerId: r.providerId! } : { sent: false, reason: "send_failed" };
  }
  if (!req.template) return { sent: false, reason: "outside_window" };
  if (req.template.category === "marketing" && !req.marketingConsent) return { sent: false, reason: "no_consent" };
  const t = req.template;
  const r = await sendAndRecord({ contactId: contact.id, kind: "template", body: t.bodyParams?.join(" | ") ?? "", template: t.name, category: t.category }, (p) => p.sendTemplate(to, t), provider);
  return r.ok ? { sent: true, via: "template", providerId: r.providerId! } : { sent: false, reason: "send_failed" };
}
