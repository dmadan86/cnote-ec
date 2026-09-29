import type { DnsRecord } from "../records";

export type EdgeState = "pending" | "active" | "failed";

export interface EdgeStatus {
  state: EdgeState;
  /** provider's own status words, for diagnostics */
  detail?: string;
  error?: string;
  /** extra DNS records the provider needs (e.g. Cloudflare ownership / DCV, Vercel verification) */
  records?: DnsRecord[];
}

/**
 * Edge port: whichever CDN/proxy terminates TLS for seller hostnames and forwards to our web app.
 * Adapters must be idempotent (createCustomHostname on an existing host returns its ref).
 */
export interface EdgeProvider {
  readonly name: string;
  /** CAA issuers this provider's certificates come from (used for the CAA warning). */
  readonly caaIssuers: string[];
  createCustomHostname(hostname: string): Promise<{ ref: string; status: EdgeStatus }>;
  getStatus(ref: string): Promise<EdgeStatus>;
  delete(ref: string): Promise<void>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
