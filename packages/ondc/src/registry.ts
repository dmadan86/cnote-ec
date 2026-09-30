// ONDC registry lookup port (ADR-017). Inbound signatures are verified against the sender's registry entry.
// `HttpRegistry` calls POST {registry}/lookup with a positive/negative TTL cache; tests inject a mock.
import { loadConfig } from "./config";

export interface RegistryEntry {
  subscriberId: string;
  uniqueKeyId: string;
  signingPublicKey: string;
  status: string;
  validFrom: Date | null;
  validUntil: Date | null;
  type: string | null;
  subscriberUrl: string | null;
}

export interface RegistryPort {
  lookup(q: { subscriberId: string; uniqueKeyId: string }): Promise<RegistryEntry | null>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Tests: replace the HTTP client used for registry lookups and callbacks. */
export function setFetch(f: FetchLike | undefined): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}
export const httpFetch: FetchLike = (url, init) => fetchImpl(url, init);

const date = (v: unknown): Date | null => {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

export function parseLookupResponse(json: unknown): RegistryEntry[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const subscriberId = typeof o.subscriber_id === "string" ? o.subscriber_id : null;
    const uk = typeof o.ukId === "string" ? o.ukId : typeof o.unique_key_id === "string" ? o.unique_key_id : null;
    const key = typeof o.signing_public_key === "string" ? o.signing_public_key : null;
    if (!subscriberId || !uk || !key) return [];
    return [{
      subscriberId, uniqueKeyId: uk, signingPublicKey: key, status: typeof o.status === "string" ? o.status : "UNKNOWN",
      validFrom: date(o.valid_from), validUntil: date(o.valid_until), type: typeof o.type === "string" ? o.type : null,
      subscriberUrl: typeof o.subscriber_url === "string" ? o.subscriber_url : null,
    }];
  });
}

/** An entry can sign requests only while SUBSCRIBED and inside its validity window. */
export function isEntryActive(e: RegistryEntry, now: Date = new Date()): boolean {
  if (e.status.toUpperCase() !== "SUBSCRIBED") return false;
  if (e.validFrom && e.validFrom > now) return false;
  if (e.validUntil && e.validUntil < now) return false;
  return true;
}

export class HttpRegistry implements RegistryPort {
  private cache = new Map<string, { at: number; entry: RegistryEntry | null }>();
  constructor(private opts: { registryUrl?: string; positiveTtlMs?: number; negativeTtlMs?: number; now?: () => number } = {}) {}

  async lookup(q: { subscriberId: string; uniqueKeyId: string }): Promise<RegistryEntry | null> {
    const now = (this.opts.now ?? Date.now)();
    const key = `${q.subscriberId}|${q.uniqueKeyId}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (hit.entry ? this.opts.positiveTtlMs ?? 600_000 : this.opts.negativeTtlMs ?? 60_000)) return hit.entry;
    const base = this.opts.registryUrl ?? loadConfig().registryUrl;
    const res = await httpFetch(`${base}/lookup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscriber_id: q.subscriberId, ukId: q.uniqueKeyId, country: loadConfig().country }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`registry lookup failed: ${res.status}`); // transient: do not negative-cache
    const entries = parseLookupResponse(JSON.parse(await res.text()) as unknown);
    const entry = entries.find((e) => e.subscriberId === q.subscriberId && e.uniqueKeyId === q.uniqueKeyId && isEntryActive(e, new Date(now))) ?? null;
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, { at: now, entry });
    return entry;
  }
}

let registry: RegistryPort | undefined;
export const getRegistry = (): RegistryPort => (registry ??= new HttpRegistry());
/** Tests: swap in a mock registry (undefined resets to the HTTP one). */
export function setRegistry(r: RegistryPort | undefined): void {
  registry = r;
}
