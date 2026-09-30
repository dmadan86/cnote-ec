// Production OtpSender adapters (fetch only, no SDKs): MSG91 SMS (TRAI DLT template), WhatsApp Cloud API
// authentication template (copy-code button) and a WhatsApp → SMS fallback. Selected by OTP_SENDER.
// See docs/design/whatsapp-channel.md. The code is never logged; phone numbers are masked.
import { createHash } from "node:crypto";
import { setOtpSender, consoleOtpSender, type OtpSender } from "./phone-login";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** `permanent` = do not retry (4xx: bad number, unapproved template, auth failure). */
export class OtpSendError extends Error {
  constructor(message: string, readonly permanent: boolean, readonly provider: string, readonly status?: number) {
    super(message);
    this.name = "OtpSendError";
  }
}

export interface OtpSenderOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** attempts including the first (retries on network errors, 429 and 5xx only) */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export const maskPhone = (p: string) => (p.length > 4 ? `${"*".repeat(p.length - 4)}${p.slice(-4)}` : "****");
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const requireEnv = (env: Env, name: string) => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required for the selected OTP sender.`);
  return v;
};

/** Stable key for one (recipient, code) delivery: sent as Idempotency-Key and used to drop in-process duplicates. */
export const otpIdempotencyKey = (to: string, code: string, channel: string) =>
  createHash("sha256").update(`${channel}:${to}:${code}`).digest("hex").slice(0, 32);

async function callWithRetry(
  provider: string,
  opts: Required<Pick<OtpSenderOptions, "timeoutMs" | "maxAttempts" | "sleep">> & { fetch: Fetch; log: (l: string) => void },
  url: string,
  init: RequestInit,
  context: string,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const res = await opts.fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      if (res.ok) return res;
      const retryable = res.status >= 500 || res.status === 429;
      const err = new OtpSendError(`${provider} responded ${res.status}`, !retryable, provider, res.status);
      if (!retryable) throw err;
      last = err;
    } catch (e) {
      if (e instanceof OtpSendError && e.permanent) throw e;
      last = e instanceof OtpSendError ? e : new OtpSendError(`${provider} request failed: ${(e as Error).name}`, false, provider);
    }
    opts.log(`[otp:${provider}] attempt ${attempt}/${opts.maxAttempts} failed for ${context}`);
    if (attempt < opts.maxAttempts) await opts.sleep(200 * 2 ** (attempt - 1));
  }
  throw last;
}

const resolveOpts = (o: OtpSenderOptions = {}) => ({
  fetch: o.fetch ?? fetch,
  timeoutMs: o.timeoutMs ?? 8000,
  maxAttempts: o.maxAttempts ?? 3,
  sleep: o.sleep ?? defaultSleep,
  log: o.log ?? ((l: string) => console.warn(l)),
});

/**
 * MSG91 SendOTP v5 (SMS). `template_id` is the MSG91 template mapped to the TRAI DLT-approved template; the
 * DLT header/sender id is configured on that template (MSG91_SENDER_ID is passed as `sender` when set).
 * The code is supplied by us (`otp=`) so verification stays in our Redis, not at MSG91.
 */
export function msg91OtpSender(env: Env = process.env, o?: OtpSenderOptions): OtpSender {
  const authKey = requireEnv(env, "MSG91_AUTH_KEY");
  const templateId = requireEnv(env, "MSG91_OTP_TEMPLATE_ID");
  const base = (env.MSG91_BASE_URL ?? "https://control.msg91.com").replace(/\/$/, "");
  const ro = resolveOpts(o);
  const seen = new Map<string, number>();
  return {
    async send({ to, code, ttlMinutes }) {
      const idem = otpIdempotencyKey(to, code, "sms");
      if ((seen.get(idem) ?? 0) > Date.now()) return;
      const q = new URLSearchParams({
        template_id: templateId, mobile: to.replace(/^\+/, ""), otp: code, otp_expiry: String(ttlMinutes), otp_length: String(code.length),
      });
      if (env.MSG91_SENDER_ID) q.set("sender", env.MSG91_SENDER_ID);
      const res = await callWithRetry(
        "msg91", ro, `${base}/api/v5/otp?${q}`,
        { method: "POST", headers: { authkey: authKey, "content-type": "application/json", accept: "application/json", "idempotency-key": idem }, body: "{}" },
        maskPhone(to),
      );
      // MSG91 answers 200 with { type: "error", message } for some rejections (bad template, DLT mismatch).
      const body = (await res.json().catch(() => null)) as { type?: string } | null;
      if (body?.type === "error") throw new OtpSendError("msg91 rejected the request", true, "msg91");
      seen.set(idem, Date.now() + 60_000);
    },
  };
}

/**
 * WhatsApp Cloud API AUTHENTICATION template with the copy-code (url) button. The template must be approved with
 * exactly one body variable {{1}} (the code) and a "Copy code" button; no other text is allowed by Meta.
 */
export function whatsappCloudOtpSender(env: Env = process.env, o?: OtpSenderOptions): OtpSender {
  const phoneId = requireEnv(env, "WHATSAPP_PHONE_NUMBER_ID");
  const token = requireEnv(env, "WHATSAPP_ACCESS_TOKEN");
  const version = env.WHATSAPP_API_VERSION ?? "v23.0";
  const template = env.WHATSAPP_OTP_TEMPLATE ?? "cnote_login_code";
  const language = env.WHATSAPP_OTP_TEMPLATE_LANG ?? "en";
  const base = (env.WHATSAPP_GRAPH_URL ?? "https://graph.facebook.com").replace(/\/$/, "");
  const ro = resolveOpts(o);
  const seen = new Map<string, number>();
  return {
    async send({ to, code }) {
      const idem = otpIdempotencyKey(to, code, "whatsapp");
      if ((seen.get(idem) ?? 0) > Date.now()) return;
      const payload = {
        messaging_product: "whatsapp",
        to: to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: template,
          language: { code: language },
          components: [
            { type: "body", parameters: [{ type: "text", text: code }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
          ],
        },
      };
      await callWithRetry(
        "whatsapp_cloud", ro, `${base}/${version}/${phoneId}/messages`,
        { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idem }, body: JSON.stringify(payload) },
        maskPhone(to),
      );
      seen.set(idem, Date.now() + 60_000);
    },
  };
}

/** Requests for channel "whatsapp" try WhatsApp first and fall back to SMS on any failure; "sms" goes straight to SMS. */
export function fallbackOtpSender(whatsapp: OtpSender, sms: OtpSender, log: (l: string) => void = (l) => console.warn(l)): OtpSender {
  return {
    async send(msg) {
      if (msg.channel === "sms") return sms.send(msg);
      try {
        await whatsapp.send(msg);
      } catch (e) {
        log(`[otp] whatsapp failed for ${maskPhone(msg.to)} (${(e as Error).message}); falling back to SMS`);
        await sms.send({ ...msg, channel: "sms" });
      }
    },
  };
}

export type OtpSenderKind = "console" | "msg91" | "whatsapp_cloud" | "whatsapp_then_sms";

/** Builds the sender named by OTP_SENDER (default console). Throws on unknown kinds or missing credentials. */
export function otpSenderFromEnv(env: Env = process.env, o?: OtpSenderOptions): OtpSender {
  const kind = (env.OTP_SENDER ?? "console").trim().toLowerCase() as OtpSenderKind;
  switch (kind) {
    case "console":
      return consoleOtpSender;
    case "msg91":
      return msg91OtpSender(env, o);
    case "whatsapp_cloud":
      return whatsappCloudOtpSender(env, o);
    case "whatsapp_then_sms":
      return fallbackOtpSender(whatsappCloudOtpSender(env, o), msg91OtpSender(env, o), o?.log);
    default:
      throw new Error(`Unknown OTP_SENDER "${kind}" (expected console|msg91|whatsapp_cloud|whatsapp_then_sms).`);
  }
}

/** Call once from each composition root (apps/web, apps/seller, apps/api, apps/worker) before serving requests. */
export function configureOtpSenderFromEnv(env: Env = process.env, o?: OtpSenderOptions): OtpSenderKind {
  setOtpSender(otpSenderFromEnv(env, o));
  return (env.OTP_SENDER ?? "console").trim().toLowerCase() as OtpSenderKind;
}
