// Parses the Meta Cloud API webhook envelope (object "whatsapp_business_account") into typed messages/statuses.
// Field names per https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
import type { InboundContent, InboundMessage, StatusUpdate, StatusValue } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (ts: unknown) => {
  const n = Number(ts);
  return new Date(Number.isFinite(n) && n > 0 ? n * 1000 : Date.now()).toISOString();
};

export function parseContent(m: Obj): InboundContent {
  const type = str(m.type) ?? "unknown";
  switch (type) {
    case "text": {
      const body = isObj(m.text) ? str(m.text.body) : undefined;
      return body !== undefined ? { type: "text", text: body } : { type: "unsupported", original: type };
    }
    case "image": {
      const i = isObj(m.image) ? m.image : {};
      const id = str(i.id);
      return id ? { type: "image", mediaId: id, mime: str(i.mime_type) ?? "image/jpeg", caption: str(i.caption) } : { type: "unsupported", original: type };
    }
    case "audio": {
      const a = isObj(m.audio) ? m.audio : {};
      const id = str(a.id);
      return id ? { type: "audio", mediaId: id, mime: str(a.mime_type) ?? "audio/ogg", voice: a.voice === true } : { type: "unsupported", original: type };
    }
    case "interactive": {
      const i = isObj(m.interactive) ? m.interactive : {};
      const r = isObj(i.button_reply) ? i.button_reply : isObj(i.list_reply) ? i.list_reply : null;
      const id = r ? str(r.id) : undefined;
      return r && id ? { type: "button", id, title: str(r.title) ?? "" } : { type: "unsupported", original: type };
    }
    case "button": {
      // quick-reply button on a template message
      const b = isObj(m.button) ? m.button : {};
      const id = str(b.payload) ?? str(b.text);
      return id ? { type: "button", id, title: str(b.text) ?? "" } : { type: "unsupported", original: type };
    }
    default:
      return { type: "unsupported", original: type };
  }
}

const STATUSES = new Set<StatusValue>(["sent", "delivered", "read", "failed"]);

export function parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (!isObj(body) || body.object !== "whatsapp_business_account") return { messages, statuses };
  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const v = change.value;
      const names = new Map<string, string>();
      for (const c of arr(v.contacts)) if (isObj(c) && str(c.wa_id)) names.set(str(c.wa_id)!, isObj(c.profile) ? (str(c.profile.name) ?? "") : "");
      for (const m of arr(v.messages)) {
        if (!isObj(m)) continue;
        const id = str(m.id);
        const from = str(m.from);
        if (!id || !from) continue;
        messages.push({ id, from, profileName: names.get(from) || undefined, timestamp: iso(m.timestamp), content: parseContent(m) });
      }
      for (const s of arr(v.statuses)) {
        if (!isObj(s)) continue;
        const id = str(s.id);
        const status = str(s.status) as StatusValue | undefined;
        if (!id || !status || !STATUSES.has(status)) continue;
        const e = arr(s.errors).find(isObj);
        statuses.push({
          id, status, recipient: str(s.recipient_id) ?? "", timestamp: iso(s.timestamp),
          error: e ? { code: Number(e.code) || 0, title: str(e.title) ?? str(e.message) ?? "error" } : undefined,
        });
      }
    }
  }
  return { messages, statuses };
}
