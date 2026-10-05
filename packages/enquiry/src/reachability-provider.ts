// Telephony port for the buyer reachability IVR (ADR-002): place a short call, "press 1 to confirm you still need this".
// The WhatsApp/SMS confirm link (reachability.ts ReachabilityNotifier) stays the fallback when the call goes unanswered.
//
// Env: REACHABILITY_IVR_PROVIDER = off (default) | mock (refused in production) | exotel | knowlarity
//      REACHABILITY_IVR_KEY / REACHABILITY_IVR_SECRET (vendor credentials), REACHABILITY_IVR_SID (Exotel account sid),
//      REACHABILITY_IVR_CALLER_ID (ExoPhone / DID shown to the buyer), REACHABILITY_IVR_FLOW_ID (Exotel call-flow app id),
//      REACHABILITY_WEBHOOK_SECRET (authenticates the status callback), REACHABILITY_CALLBACK_BASE_URL (public API origin).
//
// Vendor research (docs gated beyond the public pages; field names UNCONFIRMED until a sandbox account exists):
//   Exotel   "Outgoing call to a call flow": POST https://api.exotel.com/v1/Accounts/{sid}/Calls/connect (Basic auth key:token),
//            form fields From (buyer), CallerId (ExoPhone), Url (http://my.exotel.com/{sid}/exoml/start_voice/{flow_id}),
//            StatusCallback, CustomField. The flow (built in the Exotel dashboard) plays the prompt, gathers a digit and hits our
//            Passthru URL with CallSid, Status (completed|busy|no-answer|failed), digits, CustomField.
//            https://developer.exotel.com/docs/voice-v1/api-reference/outgoing-call-to-flow
//   Knowlarity  "Make call" (SuperReceptionist): POST https://kpi.knowlarity.com/Basic/v1/account/call/makecall, headers
//            x-api-key + authorization (SR key), JSON {k_number, agent_number, customer_number, caller_id}; call id in
//            success.call_id; the IVR result arrives via the CDR/webhook.
import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";
import { assertPublicHttpTarget, pinnedFetch } from "@cnote/security";

export type CallOutcome = "confirmed" | "denied" | "no_answer" | "failed";

export interface ReachabilityCallRequest {
  checkId: string;
  /** E.164 */
  phone: string;
  /** reply token (also the CustomField so the callback can be matched even without the call id) */
  token: string;
  language: string;
  enquiryTitle: string;
  /** where the vendor reports the result (carries the shared secret as `?secret=`) */
  callbackUrl: string;
}

export interface ReachabilityProvider {
  readonly name: string;
  place(req: ReachabilityCallRequest): Promise<{ providerRef: string }>;
  /** Authenticates and parses a vendor callback; throws DomainError("forbidden") on a bad secret, ("validation") on junk. */
  parseCallback(rawBody: string, headers: Record<string, string | undefined>, query: URLSearchParams): { providerRef: string; outcome: CallOutcome };
}

// ---- callback authenticity: HMAC header (our mock / programmable vendors) or shared secret in the query (Exotel Passthru cannot sign) ----
export const signReachabilityCallback = (secret: string, rawBody: string): string => createHmac("sha256", secret).update(rawBody).digest("hex");
const eq = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function verifyReachabilityCallback(secret: string | undefined, rawBody: string, headers: Record<string, string | undefined>, query: URLSearchParams): void {
  if (!secret) throw new DomainError("forbidden", "Invalid callback");
  const sig = headers["x-reachability-signature"]?.replace(/^sha256=/, "");
  const q = query.get("secret");
  if ((sig && eq(sig, signReachabilityCallback(secret, rawBody))) || (q && eq(q, secret))) return;
  throw new DomainError("forbidden", "Invalid callback");
}

const OUTCOMES = new Set<CallOutcome>(["confirmed", "denied", "no_answer", "failed"]);

// ---- mock (dev/tests) ----
export class MockReachabilityProvider implements ReachabilityProvider {
  readonly name = "mock";
  calls: ReachabilityCallRequest[] = [];
  failPlacing = false;
  constructor(private secret = "mock-secret") {}
  async place(req: ReachabilityCallRequest) {
    if (this.failPlacing) throw new Error("mock telephony unavailable");
    this.calls.push(req);
    return { providerRef: `mock_${req.checkId}` };
  }
  parseCallback(rawBody: string, headers: Record<string, string | undefined>, query: URLSearchParams) {
    verifyReachabilityCallback(this.secret, rawBody, headers, query);
    let o: { providerRef?: unknown; outcome?: unknown };
    try { o = JSON.parse(rawBody); } catch { throw new DomainError("validation", "Malformed callback"); }
    if (typeof o.providerRef !== "string" || !OUTCOMES.has(o.outcome as CallOutcome)) throw new DomainError("validation", "Malformed callback");
    return { providerRef: o.providerRef, outcome: o.outcome as CallOutcome };
  }
}

// ---- shared HTTP (validated target + DNS pin) ----
type Call = (url: string, init: RequestInit) => Promise<Response>;
const defaultCall: Call = async (url, init) => pinnedFetch(await assertPublicHttpTarget(url), { ...init, timeoutMs: 10_000 });

// ---- Exotel ----
export interface ExotelConfig { sid: string; key: string; token: string; callerId: string; flowId: string; webhookSecret: string; baseUrl?: string; call?: Call }
export class ExotelReachabilityProvider implements ReachabilityProvider {
  readonly name = "exotel";
  constructor(private cfg: ExotelConfig) {}
  async place(req: ReachabilityCallRequest) {
    const c = this.cfg;
    const url = `${(c.baseUrl ?? "https://api.exotel.com").replace(/\/+$/, "")}/v1/Accounts/${encodeURIComponent(c.sid)}/Calls/connect.json`;
    const body = new URLSearchParams({
      From: req.phone, CallerId: c.callerId, Url: `http://my.exotel.com/${c.sid}/exoml/start_voice/${c.flowId}`, CallType: "trans", TimeOut: "25",
      StatusCallback: req.callbackUrl, CustomField: req.token,
    });
    const res = await (c.call ?? defaultCall)(url, {
      method: "POST", body, headers: { authorization: `Basic ${Buffer.from(`${c.key}:${c.token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Exotel HTTP ${res.status}`);
    const j = (await res.json()) as { Call?: { Sid?: string }; sid?: string };
    const sid = j.Call?.Sid ?? j.sid;
    if (!sid) throw new Error("Exotel returned no call sid");
    return { providerRef: sid };
  }
  /** Exotel posts/gets application/x-www-form-urlencoded (or query): CallSid, Status, digits (quoted, e.g. "\"1\""). */
  parseCallback(rawBody: string, headers: Record<string, string | undefined>, query: URLSearchParams) {
    verifyReachabilityCallback(this.cfg.webhookSecret, rawBody, headers, query);
    const form = new URLSearchParams(rawBody || "");
    const get = (k: string) => form.get(k) ?? query.get(k) ?? undefined;
    const providerRef = get("CallSid");
    if (!providerRef) throw new DomainError("validation", "Callback has no CallSid");
    const digits = (get("digits") ?? "").replace(/["'\s]/g, "");
    const status = (get("Status") ?? "").toLowerCase();
    const outcome: CallOutcome = digits === "1" ? "confirmed" : digits === "2" ? "denied" : status === "failed" ? "failed" : "no_answer";
    return { providerRef, outcome };
  }
}

// ---- Knowlarity ----
export interface KnowlarityConfig { apiKey: string; srKey: string; kNumber: string; agentNumber: string; webhookSecret: string; baseUrl?: string; call?: Call }
export class KnowlarityReachabilityProvider implements ReachabilityProvider {
  readonly name = "knowlarity";
  constructor(private cfg: KnowlarityConfig) {}
  async place(req: ReachabilityCallRequest) {
    const c = this.cfg;
    const res = await (c.call ?? defaultCall)(`${(c.baseUrl ?? "https://kpi.knowlarity.com").replace(/\/+$/, "")}/Basic/v1/account/call/makecall`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": c.apiKey, authorization: c.srKey },
      body: JSON.stringify({ k_number: c.kNumber, agent_number: c.agentNumber, customer_number: req.phone, caller_id: c.kNumber, additional_params: { reference: req.token } }),
    });
    if (!res.ok) throw new Error(`Knowlarity HTTP ${res.status}`);
    const j = (await res.json()) as { success?: { call_id?: string } };
    if (!j.success?.call_id) throw new Error("Knowlarity returned no call id");
    return { providerRef: j.success.call_id };
  }
  /** Knowlarity IVR/CDR webhook JSON: {call_id, dtmf, status}. UNCONFIRMED mapping; adjust against the account's CDR schema. */
  parseCallback(rawBody: string, headers: Record<string, string | undefined>, query: URLSearchParams) {
    verifyReachabilityCallback(this.cfg.webhookSecret, rawBody, headers, query);
    let j: { call_id?: string; dtmf?: string | number; status?: string };
    try { j = JSON.parse(rawBody); } catch { throw new DomainError("validation", "Malformed callback"); }
    if (!j.call_id) throw new DomainError("validation", "Callback has no call_id");
    const digit = String(j.dtmf ?? "").trim();
    const status = (j.status ?? "").toLowerCase();
    return { providerRef: j.call_id, outcome: digit === "1" ? "confirmed" : digit === "2" ? "denied" : /fail|error/.test(status) ? "failed" : "no_answer" } as { providerRef: string; outcome: CallOutcome };
  }
}

// ---- selection ----
let override: ReachabilityProvider | null | undefined;
/** Tests / composition root. `null` forces IVR off; `undefined` (reset) returns to env selection. */
export function setReachabilityProvider(p: ReachabilityProvider | null | undefined): void { override = p; }

/** null = IVR off (links only). Throws DomainError for a misconfigured or production-mock selection. */
export function getReachabilityProvider(env: Record<string, string | undefined> = process.env): ReachabilityProvider | null {
  if (override !== undefined) return override;
  const name = (env.REACHABILITY_IVR_PROVIDER ?? "off").trim().toLowerCase();
  if (name === "off" || name === "") return null;
  if (name === "mock") {
    if (env.NODE_ENV === "production") throw new DomainError("validation", "REACHABILITY_IVR_PROVIDER=mock is not allowed in production");
    return new MockReachabilityProvider(env.REACHABILITY_WEBHOOK_SECRET ?? "mock-secret");
  }
  const need = (k: string) => { const v = env[k]; if (!v) throw new DomainError("validation", `${k} is required for REACHABILITY_IVR_PROVIDER=${name}`); return v; };
  if (name === "exotel") {
    return new ExotelReachabilityProvider({ sid: need("REACHABILITY_IVR_SID"), key: need("REACHABILITY_IVR_KEY"), token: need("REACHABILITY_IVR_SECRET"), callerId: need("REACHABILITY_IVR_CALLER_ID"), flowId: need("REACHABILITY_IVR_FLOW_ID"), webhookSecret: need("REACHABILITY_WEBHOOK_SECRET") });
  }
  if (name === "knowlarity") {
    return new KnowlarityReachabilityProvider({ apiKey: need("REACHABILITY_IVR_KEY"), srKey: need("REACHABILITY_IVR_SECRET"), kNumber: need("REACHABILITY_IVR_CALLER_ID"), agentNumber: need("REACHABILITY_IVR_SID"), webhookSecret: need("REACHABILITY_WEBHOOK_SECRET") });
  }
  throw new DomainError("validation", `Unknown REACHABILITY_IVR_PROVIDER "${name}" (expected off | mock | exotel | knowlarity)`);
}
