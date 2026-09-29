// Runtime configuration, read lazily from env so tests and scripts can override.

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
  };
}

/** Per-host secret the reachability probe endpoint returns; only our edge can serve it for that host. */
export function domainCheckSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOMAIN_CHECK_SECRET ?? env.JWT_SECRET ?? env.AUTH_SECRET ?? "cnote-dev-domain-check";
}
