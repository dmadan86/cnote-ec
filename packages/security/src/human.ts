// Bot / human verification port. Cloudflare Turnstile is the default; hCaptcha and reCAPTCHA share the same
// siteverify wire format so switching provider is an env change (HUMAN_VERIFIER), not a code change.
// Server-side only: the widget lives in @cnote/next-kit/client (TurnstileWidget).

export type HumanResult = { ok: true } | { ok: false; reason: string };

export interface HumanVerifier {
  readonly name: string;
  verify(token: string | null | undefined, ip?: string | null): Promise<HumanResult>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 5000;

/** Generic "siteverify" adapter (secret + response + remoteip → { success }). */
function siteverifyAdapter(name: string, endpoint: string, secret: string, doFetch: Fetch = fetch): HumanVerifier {
  return {
    name,
    async verify(token, ip) {
      if (!token || token.length > 4096) return { ok: false, reason: "missing_token" };
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set("remoteip", ip);
      try {
        const res = await doFetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return { ok: false, reason: `provider_http_${res.status}` };
        const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
        return json.success === true ? { ok: true } : { ok: false, reason: json["error-codes"]?.[0] ?? "rejected" };
      } catch {
        // Fail closed: a provider outage must not silently disable bot protection.
        return { ok: false, reason: "provider_unreachable" };
      }
    },
  };
}

export const turnstileAdapter = (secret: string, doFetch?: Fetch) =>
  siteverifyAdapter("turnstile", "https://challenges.cloudflare.com/turnstile/v0/siteverify", secret, doFetch);
export const hcaptchaAdapter = (secret: string, doFetch?: Fetch) => siteverifyAdapter("hcaptcha", "https://hcaptcha.com/siteverify", secret, doFetch);
export const recaptchaAdapter = (secret: string, doFetch?: Fetch) =>
  siteverifyAdapter("recaptcha", "https://www.google.com/recaptcha/api/siteverify", secret, doFetch);

/** Always passes. Only ever selected outside production, or explicitly with HUMAN_VERIFIER=off. */
export const devAdapter: HumanVerifier = { name: "dev", verify: async () => ({ ok: true }) };

const failClosed: HumanVerifier = { name: "unconfigured", verify: async () => ({ ok: false, reason: "not_configured" }) };

let override: HumanVerifier | null = null;
/** Test / custom-provider hook. Pass null to restore env-based selection. */
export function setHumanVerifier(v: HumanVerifier | null): void {
  override = v;
}

/**
 * Selection: HUMAN_VERIFIER=turnstile|hcaptcha|recaptcha|off. Default turnstile with TURNSTILE_SECRET.
 * Secret missing: dev adapter outside production, fail-closed in production (never silently unprotected).
 */
export function getHumanVerifier(env: Record<string, string | undefined> = process.env): HumanVerifier {
  if (override) return override;
  const kind = (env.HUMAN_VERIFIER ?? "turnstile").toLowerCase();
  if (kind === "off") return devAdapter;
  const secret = kind === "hcaptcha" ? env.HCAPTCHA_SECRET : kind === "recaptcha" ? env.RECAPTCHA_SECRET : env.TURNSTILE_SECRET;
  if (!secret) return env.NODE_ENV === "production" ? failClosed : devAdapter;
  if (kind === "hcaptcha") return hcaptchaAdapter(secret);
  if (kind === "recaptcha") return recaptchaAdapter(secret);
  return turnstileAdapter(secret);
}

/** Verify a widget token (Turnstile field `cf-turnstile-response`) for a client IP. */
export function verifyHuman(token: string | null | undefined, ip?: string | null): Promise<HumanResult> {
  return getHumanVerifier().verify(token, ip);
}
