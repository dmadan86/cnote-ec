// Video-KYC / liveness provider port (ADR-003 T2). We are not an RBI-regulated entity: this is BUSINESS verification
// (authorised signatory liveness + face match against their PAN photo), not V-CIP. The provider hosts the capture
// (hosted link, no iframe/SDK in our pages) and returns scores + a verdict. We never receive or store raw biometrics.
// See docs/design/t2-t3-verification.md for the vendor research and DPDP limits.
import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";

export interface KycSessionRequest {
  sessionId: string;
  businessId: string;
  personId: string;
  /** where the provider sends the person back after the hosted flow */
  returnUrl?: string;
}
export interface KycSessionLink {
  providerRef: string;
  /** hosted liveness / video-KYC page (full-page redirect) */
  url: string;
}
export interface KycProviderResult {
  /** pending: person has not finished; passed/failed: provider verdict */
  status: "pending" | "passed" | "failed";
  /** 0..1 */
  livenessScore?: number;
  faceMatchScore?: number;
  /** provider reason codes, e.g. "spoof_suspected", "face_mismatch" (no biometrics) */
  reasons?: string[];
}
export interface KycProvider {
  readonly name: string;
  /** mock only: the result is known immediately, so beginVideoKyc completes the session inline */
  readonly instant?: boolean;
  createSession(req: KycSessionRequest): Promise<KycSessionLink>;
  getResult(providerRef: string): Promise<KycProviderResult>;
  /** Verifies authenticity of a webhook delivery and returns the provider reference it is about; throws DomainError("forbidden") on a bad signature. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): { providerRef: string };
}

// ---- webhook signature: HMAC-SHA256(secret, rawBody) hex in `x-kyc-signature` (`sha256=` prefix tolerated) ----
export function signKycWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
export function verifyKycSignature(secret: string | undefined, rawBody: string, header: string | undefined): void {
  if (!secret || !header) throw new DomainError("forbidden", "Invalid webhook signature");
  const given = Buffer.from(header.replace(/^sha256=/, ""), "hex");
  const want = Buffer.from(signKycWebhook(secret, rawBody), "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new DomainError("forbidden", "Invalid webhook signature");
}
const webhookRef = (rawBody: string): string => {
  let o: Record<string, unknown>;
  try { o = JSON.parse(rawBody) as Record<string, unknown>; } catch { throw new DomainError("validation", "Malformed webhook body"); }
  const r = o?.providerRef ?? o?.reference ?? o?.transactionId;
  if (typeof r !== "string" || !r) throw new DomainError("validation", "Webhook has no reference");
  return r;
};

// ---- mock (dev/tests): instant, configurable result ----
export class MockKycProvider implements KycProvider {
  readonly name = "mock";
  readonly instant = true;
  constructor(public result: KycProviderResult = { status: "passed", livenessScore: 0.97, faceMatchScore: 0.92 }, private secret = "mock-secret") {}
  async createSession(req: KycSessionRequest): Promise<KycSessionLink> {
    return { providerRef: `mock_${req.sessionId}`, url: `${req.returnUrl ?? "/verification"}?mockKyc=${req.sessionId}` };
  }
  async getResult(): Promise<KycProviderResult> { return this.result; }
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    verifyKycSignature(this.secret, rawBody, headers["x-kyc-signature"]);
    return { providerRef: webhookRef(rawBody) };
  }
}

// ---- fetch-based skeleton for hosted-link vendors ----
export interface HttpKycConfig {
  name: "hyperverge" | "signzy" | "idfy";
  baseUrl: string;
  /** IDfy sends `account-id` next to `api-key` (KYC_ACCOUNT_ID) */
  accountId?: string;
  apiKey: string;
  webhookSecret: string;
  fetch?: typeof fetch;
}

/**
 * Skeleton shared by the vendor adapters. Field names below are the PLATFORM-side contract; each vendor's
 * request/response is mapped in `VENDOR` (verify against the vendor's current docs / sandbox before go-live):
 *   HyperVerge: workflow/"Link KYC" transaction  -> POST {base}/transactions {transactionId, callbackUrl, redirectUrl}; result: applicationStatus (auto_approved|auto_declined|needs_review), face-match/liveness module scores.
 *   IDfy:       Video KYC "Create Profile Link" (profile created from a configuration id) -> POST {base}/profiles {reference_id, config_id, redirect_url}; webhook/FetchProfile status APPROVED | REJECTED | PENDING + face-match results. Auth: `api-key` + `account-id` headers (https://docs.idfy.com, vendor docs gated).
 *   Signzy:     onboarding/"video KYC" journey   -> POST {base}/journeys {callbackUrl, redirectUrl, meta}; result: overall status + faceMatch/liveness objects.
 */
interface VendorMap {
  createPath: string;
  resultPath: (ref: string) => string;
  body: (r: KycSessionRequest) => Record<string, unknown>;
  ref: (json: Record<string, unknown>) => string | undefined;
  url: (json: Record<string, unknown>) => string | undefined;
  result: (json: Record<string, unknown>) => KycProviderResult;
}
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v > 1 ? v / 100 : v)) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const VENDOR: Record<HttpKycConfig["name"], VendorMap> = {
  hyperverge: {
    createPath: "/transactions", resultPath: (r) => `/transactions/${encodeURIComponent(r)}`,
    body: (r) => ({ transactionId: r.sessionId, redirectUrl: r.returnUrl, metadata: { businessId: r.businessId } }),
    ref: (j) => str(j.transactionId), url: (j) => str(j.link ?? j.url),
    result: (j) => {
      const s = str(j.applicationStatus);
      return {
        status: s === "auto_approved" ? "passed" : s === "auto_declined" ? "failed" : "pending",
        livenessScore: num(j.livenessScore), faceMatchScore: num(j.faceMatchScore), reasons: Array.isArray(j.reasons) ? j.reasons.filter((x): x is string => typeof x === "string") : undefined,
      };
    },
  },
  idfy: {
    createPath: "/profiles", resultPath: (r) => `/profiles/${encodeURIComponent(r)}`,
    body: (r) => ({ reference_id: r.sessionId, redirect_url: r.returnUrl, config_id: process.env.KYC_IDFY_CONFIG_ID, metadata: { businessId: r.businessId } }),
    ref: (j) => str(j.profile_id ?? j.id), url: (j) => str(j.profile_url ?? j.url),
    result: (j) => {
      const s = (str(j.status) ?? "").toLowerCase();
      return {
        status: s === "approved" || s === "completed" ? "passed" : s === "rejected" || s === "declined" || s === "failed" ? "failed" : "pending",
        livenessScore: num(j.liveness_score ?? j.livenessScore), faceMatchScore: num(j.face_match_score ?? j.faceMatchScore), reasons: Array.isArray(j.reasons) ? j.reasons.filter((x): x is string => typeof x === "string") : undefined,
      };
    },
  },
  signzy: {
    createPath: "/journeys", resultPath: (r) => `/journeys/${encodeURIComponent(r)}`,
    body: (r) => ({ callbackUrl: undefined, redirectUrl: r.returnUrl, meta: { sessionId: r.sessionId, businessId: r.businessId } }),
    ref: (j) => str(j.journeyId ?? j.id), url: (j) => str(j.journeyUrl ?? j.url),
    result: (j) => {
      const s = str(j.status);
      return {
        status: s === "approved" || s === "completed" ? "passed" : s === "rejected" || s === "failed" ? "failed" : "pending",
        livenessScore: num(j.livenessScore), faceMatchScore: num(j.faceMatchScore), reasons: Array.isArray(j.reasons) ? j.reasons.filter((x): x is string => typeof x === "string") : undefined,
      };
    },
  },
};

export class HttpKycProvider implements KycProvider {
  readonly name: string;
  constructor(private cfg: HttpKycConfig) { this.name = cfg.name; }
  private async call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl}${path}`, {
      ...init, headers: { ...(this.cfg.name === "idfy" ? { "api-key": this.cfg.apiKey, "account-id": this.cfg.accountId ?? "" } : { authorization: `Bearer ${this.cfg.apiKey}` }), "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new DomainError("validation", `KYC provider error (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }
  async createSession(req: KycSessionRequest): Promise<KycSessionLink> {
    const v = VENDOR[this.cfg.name];
    const j = await this.call(v.createPath, { method: "POST", body: JSON.stringify(v.body(req)) });
    const providerRef = v.ref(j), url = v.url(j);
    if (!providerRef || !url) throw new DomainError("validation", "KYC provider returned no session link");
    return { providerRef, url };
  }
  async getResult(providerRef: string): Promise<KycProviderResult> {
    const v = VENDOR[this.cfg.name];
    return v.result(await this.call(v.resultPath(providerRef)));
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    verifyKycSignature(this.cfg.webhookSecret, rawBody, headers["x-kyc-signature"]);
    return { providerRef: webhookRef(rawBody) };
  }
}

let override: KycProvider | null = null;
export function setKycProvider(p: KycProvider | null): void { override = p; }

/** KYC_PROVIDER=mock (default, non-production only) | hyperverge | signzy | idfy (KYC_ACCOUNT_ID, KYC_IDFY_CONFIG_ID); KYC_API_KEY, KYC_BASE_URL, KYC_WEBHOOK_SECRET. */
export function getKycProvider(env: Record<string, string | undefined> = process.env): KycProvider {
  if (override) return override;
  const name = (env.KYC_PROVIDER ?? "mock").toLowerCase();
  if (name === "mock") {
    if (env.NODE_ENV === "production") throw new DomainError("validation", "KYC_PROVIDER=mock is not allowed in production");
    return new MockKycProvider(undefined, env.KYC_WEBHOOK_SECRET ?? "mock-secret");
  }
  if (name === "hyperverge" || name === "signzy" || name === "idfy") {
    const apiKey = env.KYC_API_KEY, baseUrl = env.KYC_BASE_URL, webhookSecret = env.KYC_WEBHOOK_SECRET;
    if (!apiKey || !baseUrl || !webhookSecret) throw new DomainError("validation", `KYC_API_KEY, KYC_BASE_URL and KYC_WEBHOOK_SECRET are required for KYC_PROVIDER=${name}`);
    if (name === "idfy" && !env.KYC_ACCOUNT_ID) throw new DomainError("validation", "KYC_ACCOUNT_ID is required for KYC_PROVIDER=idfy");
    return new HttpKycProvider({ name, apiKey, baseUrl, webhookSecret, accountId: env.KYC_ACCOUNT_ID });
  }
  throw new DomainError("validation", `Unknown KYC_PROVIDER "${name}"`);
}
