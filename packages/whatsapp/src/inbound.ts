// Webhook intake (fast path: verify, parse, enqueue) and the "whatsapp.inbound" consumer (idempotent by wamid).
import { redactPii } from "@cnote/ai";
import { getJobQueue, redis, type JobQueue, type QueueMessage } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hashPhone } from "@cnote/identity";
import { isLang } from "./copy";
import { runFlow, sendReply } from "./conversation";
import { isOptIn, isOptOut } from "./keywords";
import { coerceState, type Input } from "./machine";
import { getPorts } from "./ports";
import { getWhatsAppProvider, type WhatsAppProvider } from "./provider";
import { parseWebhook } from "./parse";
import { verifySignature } from "./signature";
import type { InboundContent, InboundJob, InboundMessage, StatusUpdate } from "./types";
import { extendWindow } from "./window";

type HeaderBag = Headers | Record<string, string | string[] | undefined>;
const header = (h: HeaderBag, name: string): string | undefined => {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export interface WebhookResult {
  status: 200 | 400 | 401;
  enqueued: number;
}

/** POST /webhooks/whatsapp. `rawBody` MUST be the untouched request body (the HMAC covers exact bytes). */
export async function handleWebhook(rawBody: string | Uint8Array, headers: HeaderBag, opts: { queue?: JobQueue; appSecret?: string } = {}): Promise<WebhookResult> {
  if (!verifySignature(rawBody, header(headers, "x-hub-signature-256"), opts.appSecret)) return { status: 401, enqueued: 0 };
  let json: unknown;
  try {
    json = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"));
  } catch {
    return { status: 400, enqueued: 0 };
  }
  const { messages, statuses } = parseWebhook(json);
  const queue = opts.queue ?? getJobQueue();
  let enqueued = 0;
  for (const message of messages) {
    if (await queue.enqueue("whatsapp.inbound", { kind: "message", message }, { dedupeKey: `wa:${message.id}` })) enqueued++;
  }
  for (const status of statuses) {
    if (await queue.enqueue("whatsapp.inbound", { kind: "status", status }, { dedupeKey: `wa:${status.id}:${status.status}` })) enqueued++;
  }
  return { status: 200, enqueued };
}

// ------------------------------------------------------------------ consumer
const RANK: Record<string, number> = { received: 0, sent: 1, delivered: 2, read: 3 };

export async function applyStatus(s: StatusUpdate): Promise<void> {
  const row = await prisma.whatsAppMessage.findUnique({ where: { providerId: s.id }, select: { id: true, status: true, direction: true } });
  if (!row || row.direction !== "out") return;
  const better = s.status === "failed" ? row.status !== "read" : (RANK[s.status] ?? 0) > (RANK[row.status] ?? 0);
  if (!better) return;
  await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { status: s.status } });
  if (s.status === "failed") console.warn(`[whatsapp] delivery failed code=${s.error?.code ?? "?"} ${s.error?.title ?? ""}`);
}

function toInput(c: InboundContent): Input {
  switch (c.type) {
    case "text": return { type: "text", text: c.text };
    case "button": return { type: "button", id: c.id };
    case "image": return { type: "media", kind: "image", mediaId: c.mediaId, mime: c.mime };
    case "audio": return { type: "media", kind: "audio", mediaId: c.mediaId, mime: c.mime };
    default: return { type: "other" };
  }
}

const kindOf = (c: InboundContent) => (c.type === "unsupported" ? "text" : c.type === "button" ? "interactive" : c.type);
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

export interface ProcessDeps {
  provider?: WhatsAppProvider;
  now?: () => Date;
}

/** Handles one inbound customer message. Idempotent: a wamid is processed once. */
export async function processInboundMessage(m: InboundMessage, deps: ProcessDeps = {}): Promise<"processed" | "duplicate" | "ignored"> {
  const provider = deps.provider ?? getWhatsAppProvider();
  const now = deps.now?.() ?? new Date();
  let phoneHash: string;
  try {
    phoneHash = hashPhone(`+${m.from}`);
  } catch {
    return "ignored";
  }
  const lockKey = `wa:lock:${phoneHash}`;
  if (!(await redis.set(lockKey, "1", "EX", 60, "NX"))) throw new Error("conversation busy"); // queue retries with backoff
  try {
    const sentAt = new Date(m.timestamp);
    const contact0 = await prisma.whatsAppContact.upsert({ where: { phoneHash }, create: { phoneHash }, update: {} });
    const state = coerceState(contact0.state, isLang(contact0.language) ? contact0.language : "en");
    const consented = state.data.consent === true;
    const c = m.content;
    // Data minimisation: no message text is kept before the seller has consented.
    const body = !consented ? null : c.type === "text" ? redactPii(c.text).slice(0, 200) : c.type === "button" ? c.title.slice(0, 60) : c.type === "image" ? (c.caption ? redactPii(c.caption).slice(0, 200) : null) : null;
    try {
      await prisma.whatsAppMessage.create({ data: { contactId: contact0.id, direction: "in", providerId: m.id, kind: kindOf(c), body, status: "received" } });
    } catch (e) {
      if (isUnique(e)) return "duplicate";
      throw e;
    }
    try {
      const contact = await prisma.whatsAppContact.update({ where: { id: contact0.id }, data: { windowUntil: extendWindow(contact0.windowUntil, sentAt) } });
      void provider.markRead(m.id).catch(() => {});
      const flowCtx = { contact, to: m.from, now, provider, ports: getPorts() };

      if (c.type === "text" && isOptOut(c.text)) {
        await prisma.whatsAppContact.update({ where: { id: contact.id }, data: { optedOutAt: now } });
        if (contact.personId) await getPorts().recordConsent(contact.personId, "marketing", false, "whatsapp_stop").catch(() => {});
        await sendReply(flowCtx, { ...state }, { t: "reply", key: "opted_out" });
        return "processed";
      }
      if (contact.optedOutAt) {
        if (c.type === "text" && isOptIn(c.text)) {
          await prisma.whatsAppContact.update({ where: { id: contact.id }, data: { optedOutAt: null } });
          await sendReply(flowCtx, state, { t: "reply", key: "opted_in" });
          return "processed";
        }
        return "ignored"; // opted out: stay silent
      }
      await runFlow(flowCtx, toInput(c));
      return "processed";
    } catch (e) {
      // Let the retry re-run this message rather than swallowing it as a duplicate.
      await prisma.whatsAppMessage.deleteMany({ where: { providerId: m.id } });
      throw e;
    }
  } finally {
    await redis.del(lockKey);
  }
}

export async function handleInboundJob(msg: QueueMessage<InboundJob>, deps: ProcessDeps = {}): Promise<void> {
  const job = msg.payload;
  if (job.kind === "status") await applyStatus(job.status);
  else await processInboundMessage(job.message, deps);
}
