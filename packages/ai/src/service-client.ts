// Language-neutral service-to-service plumbing shared by the AI and Search remote transports (ADR-018, ADR-023):
//   * short-lived HS256 service tokens (JWT, audience per service, key rotation via "current,previous"),
//   * a circuit breaker, and an HTTP client with timeouts + bounded retries (idempotent calls only),
//   * a JSON codec for binary fields ({ "$base64": "..." }) so the wire format stays plain JSON.
// Nothing here knows about any capability; see remote.ts for the AI wire contract.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------------------------- tokens
export interface ServiceTokenClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** `secret` may hold several keys ("current,previous"); tokens are always signed with the first. */
export const splitSecrets = (secret: string): string[] => secret.split(",").map((s) => s.trim()).filter(Boolean);

export function signServiceToken(o: { secret: string; audience: string; issuer: string; ttlSeconds?: number; nowMs?: number }): string {
  const key = splitSecrets(o.secret)[0];
  if (!key) throw new Error("service token secret is empty");
  const iat = Math.floor((o.nowMs ?? Date.now()) / 1000);
  const claims: ServiceTokenClaims = { iss: o.issuer, aud: o.audience, iat, exp: iat + (o.ttlSeconds ?? 60), jti: randomUUID() };
  const body = `${HEADER}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export type TokenVerdict = { ok: true; claims: ServiceTokenClaims } | { ok: false; reason: "malformed" | "signature" | "audience" | "expired" | "not_yet_valid" | "ttl_too_long" };

export function verifyServiceToken(
  token: string,
  o: { secret: string; audience: string; nowMs?: number; skewSeconds?: number; maxTtlSeconds?: number },
): TokenVerdict {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: "malformed" };
  const body = `${parts[0]}.${parts[1]}`;
  // canonical base64url string comparison (decoded bytes would accept several spellings of one signature)
  const given = Buffer.from(parts[2]!);
  const signatureOk = splitSecrets(o.secret).some((k) => {
    const want = Buffer.from(createHmac("sha256", k).update(body).digest("base64url"));
    return want.length === given.length && timingSafeEqual(want, given);
  });
  if (!signatureOk) return { ok: false, reason: "signature" };
  let claims: ServiceTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as ServiceTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number" || typeof claims.iss !== "string") return { ok: false, reason: "malformed" };
  if (claims.aud !== o.audience) return { ok: false, reason: "audience" };
  const now = Math.floor((o.nowMs ?? Date.now()) / 1000);
  const skew = o.skewSeconds ?? 5;
  if (claims.exp + skew < now) return { ok: false, reason: "expired" };
  if (claims.iat - skew > now) return { ok: false, reason: "not_yet_valid" };
  if (claims.exp - claims.iat > (o.maxTtlSeconds ?? 300)) return { ok: false, reason: "ttl_too_long" };
  return { ok: true, claims };
}

// ---------------------------------------------------------------------------------------------- binary codec
/** Uint8Array <-> {"$base64": "..."}; applied recursively so any capability input can carry pixels/audio. */
export function encodeWire(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $base64: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map(encodeWire);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, encodeWire(x)]));
  return v;
}
export function decodeWire(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeWire);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$base64 === "string" && Object.keys(o).length === 1) return new Uint8Array(Buffer.from(o.$base64, "base64"));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decodeWire(x)]));
  }
  return v;
}

// ---------------------------------------------------------------------------------------------- circuit breaker
export type BreakerState = "closed" | "open" | "half_open";

/** Opens after `failureThreshold` consecutive failures; after `cooldownMs` lets ONE probe through (half-open). */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(o: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.threshold = o.failureThreshold ?? 5;
    this.cooldownMs = o.cooldownMs ?? 30_000;
    this.now = o.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.failures < this.threshold) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /** Whether a call may proceed right now. In half-open only the first caller gets the probe. */
  allow(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "open" || this.probing) return false;
    this.probing = true;
    return true;
  }

  success() {
    this.failures = 0;
    this.probing = false;
  }

  failure() {
    this.failures++;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

// ---------------------------------------------------------------------------------------------- HTTP client
/** The service is unreachable, overloaded or broken: callers may fall back. */
export class ServiceUnavailableError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly requestId?: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
/** The service answered with a non-retryable 4xx (bad input or bad credentials): a caller bug or misconfiguration, never a fallback case. */
export class ServiceRejectedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly requestId?: string) {
    super(message);
    this.name = "ServiceRejectedError";
  }
}

export interface ServiceClientOptions {
  name: string;
  baseUrl: string;
  audience: string;
  issuer: string;
  secret: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ServiceClient {
  readonly breaker: CircuitBreaker;
  private readonly name: string;
  private readonly baseUrl: string;
  private readonly audience: string;
  private readonly issuer: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: ServiceClientOptions) {
    this.breaker = o.breaker ?? new CircuitBreaker();
    this.name = o.name;
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.audience = o.audience;
    this.issuer = o.issuer;
    this.secret = o.secret;
    this.timeoutMs = o.timeoutMs ?? 8000;
    this.retries = o.retries ?? 2;
    this.backoffMs = o.backoffMs ?? 100;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * JSON call. `retry` must only be true for idempotent operations. Throws ServiceUnavailableError (breaker open, network,
   * timeout, 5xx, malformed body) or ServiceRejectedError (4xx).
   */
  async request<T>(method: "GET" | "POST", path: string, body: unknown, opts: { retry: boolean; timeoutMs?: number }): Promise<{ data: T; requestId: string }> {
    const attempts = opts.retry ? this.retries + 1 : 1;
    let last: ServiceUnavailableError | undefined;
    for (let i = 0; i < attempts; i++) {
      if (!this.breaker.allow()) throw new ServiceUnavailableError(`${this.name} circuit open`);
      try {
        const res = await this.once<T>(method, path, body, opts.timeoutMs ?? this.timeoutMs);
        this.breaker.success();
        return res;
      } catch (err) {
        if (err instanceof ServiceRejectedError) {
          this.breaker.success(); // the service is healthy, the request was bad
          throw err;
        }
        this.breaker.failure();
        last = err as ServiceUnavailableError;
        if (i < attempts - 1) await this.sleep(this.backoffMs * 2 ** i);
      }
    }
    throw last!;
  }

  private async once<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<{ data: T; requestId: string }> {
    const requestId = randomUUID();
    const token = signServiceToken({ secret: this.secret, audience: this.audience, issuer: this.issuer });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "x-request-id": requestId, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(encodeWire(body)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new ServiceUnavailableError(`${this.name} ${timedOut ? `timed out after ${timeoutMs}ms` : `unreachable: ${err instanceof Error ? err.message : String(err)}`}`, null, requestId);
    }
    const rid = res.headers.get("x-request-id") ?? requestId;
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const msg = `${this.name} ${res.status}: ${j?.error?.message ?? res.statusText}`;
      if (RETRYABLE_STATUS.has(res.status) || res.status >= 500) throw new ServiceUnavailableError(msg, res.status, rid);
      throw new ServiceRejectedError(msg, res.status, j?.error?.code ?? null, rid);
    }
    try {
      return { data: decodeWire(await res.json()) as T, requestId: rid };
    } catch {
      throw new ServiceUnavailableError(`${this.name} returned a malformed body`, res.status, rid);
    }
  }
}
