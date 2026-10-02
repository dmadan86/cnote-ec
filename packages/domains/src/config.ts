// Runtime configuration, read lazily from env so tests and scripts can override.
import { hkdfSync } from "node:crypto";

export interface DomainsConfig {
  /** Root for platform subdomains: <slug>.<root>. Dev default "localhost". */
  rootDomain: string;
  /** CNAME target sellers point www.* hosts at (default stores.<root>). */
  cnameTarget: string;
  /** A records for apex domains; empty means "use ALIAS/ANAME/flattening to the CNAME target". */
  apexIps: string[];
  /** Public resolvers used for verification (never the system resolver, which may be split-horizon). */
  resolvers: string[];
  provider: "mock" | "cloudflare" | "vercel" | "aws";
  /** Extra hosts that are the marketplace itself (never storefronts). Supports "*.suffix". */
  platformHosts: string[];
  maxDomainsPerStorefront: number;
  /** An unverified (not DNS-proven) claim on a hostname is dropped after this many days (anti-squatting). */
  pendingClaimDays: number;
}

const list = (v: string | undefined, fallback: string[] = []) =>
  v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback;

export function domainsConfig(env: NodeJS.ProcessEnv = process.env): DomainsConfig {
  const rootDomain = (env.STOREFRONT_ROOT_DOMAIN ?? "localhost").trim().toLowerCase();
  const provider = (env.EDGE_PROVIDER ?? "mock").trim().toLowerCase();
  return {
    rootDomain,
    cnameTarget: (env.STOREFRONT_CNAME_TARGET ?? `stores.${rootDomain}`).trim().toLowerCase(),
    apexIps: list(env.STOREFRONT_APEX_IPS),
    resolvers: list(env.DOMAINS_DNS_RESOLVERS, ["1.1.1.1", "8.8.8.8"]),
    provider: (["mock", "cloudflare", "vercel", "aws"].includes(provider) ? provider : "mock") as DomainsConfig["provider"],
    platformHosts: list(env.PLATFORM_HOSTS),
    maxDomainsPerStorefront: 3,
    pendingClaimDays: Math.max(1, Number(env.DOMAINS_PENDING_CLAIM_DAYS) || 7),
  };
}

/**
 * Per-host secret the reachability probe endpoint returns; only our edge can serve it for that host.
 * Derived with HKDF-SHA256 from a DEDICATED `DOMAIN_CHECK_SECRET`: no hardcoded fallback and no reuse of JWT_SECRET /
 * AUTH_SECRET (a leaked probe token must never be usable against sessions, and a missing secret must fail loudly rather
 * than fall back to a value anyone can read in the repo). Generate with `openssl rand -base64 32`.
 */
export function domainCheckSecret(env: NodeJS.ProcessEnv = process.env): string {
  const ikm = env.DOMAIN_CHECK_SECRET?.trim();
  if (!ikm) throw new Error("DOMAIN_CHECK_SECRET is not set (a dedicated secret is required; it is not derived from JWT_SECRET)");
  return Buffer.from(hkdfSync("sha256", ikm, "cnote:domains:v1", "domain-check-token", 32)).toString("hex");
}
