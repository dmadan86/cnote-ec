// Provider port for the WhatsApp Business Platform. Adapters: meta_cloud (real) and mock (tests/dev).
import { metaConfig, type MetaConfig } from "./config";
import type { InteractiveMessage, MediaBytes, SendResult, TemplateMessage } from "./types";

export class WhatsAppError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly permanent = status >= 400 && status < 500 && status !== 429) {
    super(message);
    this.name = "WhatsAppError";
  }
}
/** Meta error 131047: free-form message outside the 24h customer service window (use a template). */
export const OUTSIDE_WINDOW_CODE = 131047;

export interface WhatsAppProvider {
  readonly name: string;
  /** Free-form text: only valid inside the 24h window. `to` is digits with country code (no "+"). */
  sendText(to: string, text: string): Promise<SendResult>;
  sendTemplate(to: string, template: TemplateMessage): Promise<SendResult>;
  sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult>;
  downloadMedia(mediaId: string): Promise<MediaBytes>;
  markRead(messageId: string): Promise<void>;
}

// ---------------------------------------------------------------- meta_cloud
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export function metaCloudProvider(cfg: MetaConfig = metaConfig(), f: typeof fetch = fetch, timeoutMs = 10_000): WhatsAppProvider {
  const base = `${cfg.graphUrl}/${cfg.apiVersion}`;
  const auth = { authorization: `Bearer ${cfg.accessToken}` };
  const call = async (url: string, init: RequestInit = {}) => {
    let res: Response;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new WhatsAppError(`WhatsApp request failed: ${(e as Error).name}`, 0, undefined, false);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
      throw new WhatsAppError(body?.error?.message ?? `WhatsApp responded ${res.status}`, res.status, body?.error?.code);
    }
    return res;
  };
  const post = async (payload: Record<string, unknown>): Promise<SendResult> => {
    const res = await call(`${base}/${cfg.phoneNumberId}/messages`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    const j = (await res.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
    const id = j?.messages?.[0]?.id;
    if (!id) throw new WhatsAppError("WhatsApp response had no message id", 502, undefined, false);
    return { providerId: id };
  };
  return {
    name: "meta_cloud",
    sendText: (to, text) => post({ recipient_type: "individual", to, type: "text", text: { body: text, preview_url: false } }),
    sendTemplate: (to, t) =>
      post({
        to, type: "template",
        template: {
          name: t.name, language: { code: t.language },
          ...(t.bodyParams?.length ? { components: [{ type: "body", parameters: t.bodyParams.map((text) => ({ type: "text", text })) }] } : {}),
        },
      }),
    sendInteractive: (to, m) => {
      const interactive = m.list
        ? { type: "list", body: { text: m.body }, action: { button: m.list.button.slice(0, 20), sections: [{ title: "Options", rows: m.list.rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }] } }
        : { type: "button", body: { text: m.body }, action: { buttons: (m.buttons ?? []).slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } };
      return post({ recipient_type: "individual", to, type: "interactive", interactive });
    },
    async downloadMedia(mediaId) {
      // Step 1: media id -> short-lived URL; step 2: GET the URL WITH the bearer token (it is not public).
      const meta = (await (await call(`${base}/${encodeURIComponent(mediaId)}`, { headers: auth })).json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!meta.url) throw new WhatsAppError("Media URL missing", 502, undefined, false);
      if (meta.file_size && meta.file_size > MAX_MEDIA_BYTES) throw new WhatsAppError("Media too large", 413, undefined, true);
      const bin = await call(meta.url, { headers: auth });
      const bytes = new Uint8Array(await bin.arrayBuffer());
      if (bytes.byteLength > MAX_MEDIA_BYTES) throw new WhatsAppError("Media too large", 413, undefined, true);
      return { bytes, mime: meta.mime_type ?? bin.headers.get("content-type") ?? "application/octet-stream" };
    },
    async markRead(messageId) {
      await post({ status: "read", message_id: messageId });
    },
  };
}

// ---------------------------------------------------------------- mock
export interface SentRecord {
  kind: "text" | "template" | "interactive";
  to: string;
  text?: string;
  template?: TemplateMessage;
  interactive?: InteractiveMessage;
  providerId: string;
}
export interface MockWhatsAppProvider extends WhatsAppProvider {
  sent: SentRecord[];
  read: string[];
  media: Map<string, MediaBytes>;
  /** make the next N sends throw (tests) */
  failNext: number;
  reset(): void;
}

export function mockProvider(opts: { log?: boolean } = {}): MockWhatsAppProvider {
  let n = 0;
  const p: MockWhatsAppProvider = {
    name: "mock",
    sent: [],
    read: [],
    media: new Map(),
    failNext: 0,
    reset() {
      p.sent = [];
      p.read = [];
      p.failNext = 0;
    },
    async sendText(to, text) {
      return rec({ kind: "text", to, text });
    },
    async sendTemplate(to, template) {
      return rec({ kind: "template", to, template });
    },
    async sendInteractive(to, interactive) {
      return rec({ kind: "interactive", to, interactive, text: interactive.body });
    },
    async downloadMedia(id) {
      const m = p.media.get(id);
      if (!m) throw new WhatsAppError("no such media", 404);
      return m;
    },
    async markRead(id) {
      p.read.push(id);
    },
  };
  function rec(r: Omit<SentRecord, "providerId">): SendResult {
    if (p.failNext > 0) {
      p.failNext--;
      throw new WhatsAppError("mock failure", 500, undefined, false);
    }
    const providerId = `wamid.mock${++n}`;
    p.sent.push({ ...r, providerId });
    if (opts.log) console.info(`[whatsapp:mock] to=***${r.to.slice(-4)} ${r.kind} ${r.text ?? r.template?.name ?? ""}`);
    return { providerId };
  }
  return p;
}

// ---------------------------------------------------------------- registry
let current: WhatsAppProvider | undefined;
/** WHATSAPP_PROVIDER=meta_cloud|mock; default meta_cloud when an access token is configured, else mock (dev console log). */
export function getWhatsAppProvider(): WhatsAppProvider {
  if (current) return current;
  const kind = process.env.WHATSAPP_PROVIDER ?? (process.env.WHATSAPP_ACCESS_TOKEN ? "meta_cloud" : "mock");
  current = kind === "meta_cloud" ? metaCloudProvider() : mockProvider({ log: true });
  return current;
}
export const setWhatsAppProvider = (p: WhatsAppProvider | undefined) => void (current = p);
