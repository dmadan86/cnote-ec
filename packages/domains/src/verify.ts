import { createHmac } from "node:crypto";
import { domainCheckSecret, type DomainsConfig } from "./config";
import { checkDns, type DnsDiagnostics, type DnsResolver } from "./dns";
import type { EdgeProvider, EdgeStatus } from "./edge/types";
import type { DomainKind } from "./hostname";

export type DomainStatusName = "pending_dns" | "verifying" | "verified" | "provisioning_tls" | "active" | "misconfigured" | "removed";

export const CHECK_PATH = "/.well-known/cnote-domain-check";
export const PENDING_DNS_WINDOW_MS = 72 * 3600_000;
export const TLS_WINDOW_MS = 24 * 3600_000;

export interface ProbeResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  error?: string;
}

export interface LastCheck {
  at: string;
  /** start of the current 72h pending window; reset by a manual re-check */
  windowStartedAt: string;
  dns: DnsDiagnostics;
  edge?: { provider: string; state: EdgeStatus["state"]; detail?: string; error?: string; records?: EdgeStatus["records"] };
  probe?: ProbeResult;
}

export interface DomainState {
  hostname: string;
  kind: DomainKind;
  status: DomainStatusName;
  verifyToken: string;
  providerRef: string | null;
  checkCount: number;
  createdAt: Date;
  verifiedAt: Date | null;
  windowStartedAt: Date;
}

export interface EvalDeps {
  resolver: DnsResolver;
  edge: EdgeProvider;
  probe: (hostname: string) => Promise<ProbeResult>;
  cfg: DomainsConfig;
  now?: () => Date;
}

export interface Outcome {
  /** statuses passed through, in order, ending at `status` (first element is the starting status) */
  walk: DomainStatusName[];
  status: DomainStatusName;
  error: string | null;
  /** re-enqueue after this many ms; null = stop the chain */
  requeueMs: number | null;
  providerRef: string | null;
  lastCheck: LastCheck;
}

/** Backoff while waiting for the seller's DNS: 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, then hourly. */
export function pendingBackoffMs(checkCount: number): number {
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800];
  return (steps[checkCount] ?? 3600) * 1000;
}
/** Backoff while the edge issues the certificate: 15s up to 5 minutes. */
export function tlsBackoffMs(checkCount: number): number {
  return Math.min(15_000 * 2 ** Math.min(checkCount, 5), 300_000);
}

export function domainCheckToken(hostname: string, secret: string = domainCheckSecret()): string {
  return createHmac("sha256", secret).update(hostname.toLowerCase()).digest("hex");
}

/** GET https://<host>/.well-known/cnote-domain-check and compare the per-host token. */
export async function httpProbe(hostname: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`https://${hostname}${CHECK_PATH}`, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { accept: "application/json", "user-agent": "cnote-domain-check/1" } });
    if (!res.ok) return { ok: false, status: res.status, error: `Your domain answered with HTTP ${res.status} instead of our check response.` };
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    if (body?.token !== domainCheckToken(hostname)) return { ok: false, status: res.status, error: "Your domain answered, but not from our servers. Check that it points to us." };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: `Could not open https://${hostname} (${err instanceof Error ? err.message : "network error"}).` };
  }
}

/** Probe is skipped for the mock edge (no real TLS in dev) or when DOMAINS_HTTP_PROBE=off. */
export function defaultProbe(cfg: DomainsConfig): (hostname: string) => Promise<ProbeResult> {
  const skip = cfg.provider === "mock" || process.env.DOMAINS_HTTP_PROBE === "off";
  return skip ? async () => ({ ok: true, skipped: true }) : (h) => httpProbe(h);
}

/**
 * The domain state machine as one pure-ish step (I/O only through `deps`):
 *   pending_dns -> verifying -> verified -> provisioning_tls -> active
 *   any -> misconfigured (DNS broke, edge failed, or a window expired); misconfigured -> recovers on a passing check.
 */
export async function evaluateDomain(d: DomainState, deps: EvalDeps): Promise<Outcome> {
  const now = (deps.now ?? (() => new Date()))();
  const dns = await checkDns(deps.resolver, d, deps.cfg, deps.edge.caaIssuers, () => now);
  const lastCheck: LastCheck = { at: now.toISOString(), windowStartedAt: d.windowStartedAt.toISOString(), dns };
  const done = (status: DomainStatusName, error: string | null, requeueMs: number | null, walk: DomainStatusName[] = [], providerRef = d.providerRef): Outcome => ({
    walk: [d.status, ...walk, status].filter((s, i, a) => i === 0 || s !== a[i - 1]),
    status,
    error,
    requeueMs,
    providerRef,
    lastCheck,
  });
  const wasLive = d.verifiedAt !== null || d.status === "active" || d.status === "provisioning_tls" || d.status === "verified";

  if (!dns.ok) {
    // A resolver hiccup must not knock a working domain offline: keep its state and retry soon.
    if (wasLive && dns.lookupErrors > 0 && (dns.txt.ok || dns.routing.ok || dns.txt.observed.length === 0)) {
      const keep = d.status === "misconfigured" ? "misconfigured" : d.status;
      return done(keep, dns.problems[0] ?? null, 10 * 60_000);
    }
    if (wasLive) return done("misconfigured", dns.problems[0] ?? "DNS records no longer match.", null);
    const age = now.getTime() - d.windowStartedAt.getTime();
    if (age >= PENDING_DNS_WINDOW_MS) {
      return done("misconfigured", "We did not detect the DNS records within 72 hours. Fix the records and press Re-check.", null);
    }
    return done("pending_dns", dns.problems[0] ?? null, pendingBackoffMs(d.checkCount));
  }

  // DNS matches: ownership + routing confirmed.
  const walk: DomainStatusName[] = ["active", "provisioning_tls", "verified"].includes(d.status) ? [] : ["verifying", "verified"];
  const viaTls: DomainStatusName[] = d.status === "active" ? [] : [...walk, "provisioning_tls"];
  let ref = d.providerRef;
  let edge: EdgeStatus;
  try {
    if (!ref) {
      const created = await deps.edge.createCustomHostname(d.hostname);
      ref = created.ref;
      edge = created.status;
    } else {
      edge = await deps.edge.getStatus(ref);
    }
  } catch (err) {
    // transient provider failure: stay where we are (at least "verified") and retry
    const msg = `Edge provider error: ${err instanceof Error ? err.message : String(err)}`;
    const stay: DomainStatusName = d.status === "active" || d.status === "provisioning_tls" ? d.status : "verified";
    return done(stay, msg, 2 * 60_000, stay === d.status ? [] : ["verifying", "verified"] as DomainStatusName[], ref);
  }
  lastCheck.edge = { provider: deps.edge.name, state: edge.state, detail: edge.detail, error: edge.error, records: edge.records };

  if (edge.state === "failed") return done("misconfigured", edge.error ?? "The certificate provider rejected this domain.", null, viaTls, ref);

  const since = (d.verifiedAt ?? now).getTime();
  const tlsExpired = now.getTime() - since >= TLS_WINDOW_MS;

  if (edge.state === "pending") {
    if (tlsExpired) return done("misconfigured", "The TLS certificate was not issued within 24 hours. Check your CAA records and DNS, then press Re-check.", null, viaTls, ref);
    return done("provisioning_tls", edge.error ?? null, tlsBackoffMs(d.checkCount), walk, ref);
  }

  // edge active: confirm end-to-end reachability from the public internet
  const probe = await deps.probe(d.hostname);
  lastCheck.probe = probe;
  if (probe.ok) return done("active", null, null, viaTls, ref);
  if (d.status === "active" || tlsExpired) return done("misconfigured", probe.error ?? "The domain is not reachable over HTTPS.", null, viaTls, ref);
  return done("provisioning_tls", probe.error ?? null, tlsBackoffMs(d.checkCount), walk, ref);
}
