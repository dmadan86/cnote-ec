import { cachedTagged, invalidateTags } from "@cnote/core";
import { prisma } from "@cnote/db";
import { domainsConfig } from "./config";
import { hostFromHeader, isPlatformHost, subdomainSlug } from "./hostname";

export type ResolvedHost =
  | { kind: "platform"; storefrontSlug: null; canonicalHost: string }
  | { kind: "custom" | "subdomain"; storefrontSlug: string; canonicalHost: string };

const HOST_TTL_S = 60;

export const hostTag = (host: string) => `host:${host}`;
const canonTag = (slug: string) => `sfcanon:${slug}`;

async function primaryActiveHost(storefrontId: string): Promise<string | null> {
  const p = await prisma.storefrontDomain.findFirst({ where: { storefrontId, status: "active", isPrimary: true }, select: { hostname: true } });
  return p?.hostname ?? null;
}

async function loadHost(h: string): Promise<ResolvedHost | null> {
  const cfg = domainsConfig();
  const slug = subdomainSlug(h, cfg);
  if (slug) {
    const sf = await prisma.storefront.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!sf || sf.status !== "live") return null;
    return { kind: "subdomain", storefrontSlug: slug, canonicalHost: (await primaryActiveHost(sf.id)) ?? h };
  }
  if (h === cfg.rootDomain || h.endsWith(`.${cfg.rootDomain}`)) return null;
  const row = await prisma.storefrontDomain.findFirst({ where: { hostname: h, status: "active" }, select: { status: true, isPrimary: true, storefront: { select: { id: true, slug: true, status: true } } } });
  if (!row || row.status !== "active" || row.storefront.status !== "live") return null;
  const primary = row.isPrimary ? h : ((await primaryActiveHost(row.storefront.id)) ?? h);
  return { kind: "custom", storefrontSlug: row.storefront.slug, canonicalHost: primary };
}

/**
 * Which storefront (if any) serves this Host header? Platform hosts are answered without I/O.
 * Custom domains resolve only when ACTIVE (verified + TLS). Unknown hosts return null; results (including null) are
 * cached 60s in Redis under tag host:<host>, and write paths invalidate that tag, so changes apply immediately.
 */
export async function resolveHost(host: string): Promise<ResolvedHost | null> {
  const h = hostFromHeader(host);
  if (!h) return null;
  if (isPlatformHost(h, domainsConfig())) return { kind: "platform", storefrontSlug: null, canonicalHost: h };
  return cachedTagged<ResolvedHost | null>(`host:v1:${h}`, [hostTag(h)], HOST_TTL_S, () => loadHost(h));
}

export function platformSubdomainHost(slug: string): string {
  return `${slug}.${domainsConfig().rootDomain}`;
}

function originFor(host: string): string {
  const cfg = domainsConfig();
  const local = cfg.rootDomain === "localhost" && host.endsWith("localhost");
  return local ? `http://${host}:${process.env.WEB_PORT ?? 3000}` : `https://${host}`;
}

/** Canonical public URL origin of a storefront: its primary active custom domain, else <slug>.<root>. */
/**
 * Origin of the storefront's primary ACTIVE custom domain (e.g. "https://www.acme.com"), or null when it has none.
 * SEO policy: an active custom domain is canonical; otherwise the marketplace's /store/<slug> is.
 */
export async function customDomainOrigin(slug: string): Promise<string | null> {
  const host = await cachedTagged<string>(`sfcustom:v1:${slug}`, [canonTag(slug)], 300, async () => {
    const sf = await prisma.storefront.findUnique({ where: { slug }, select: { id: true } });
    return (sf && (await primaryActiveHost(sf.id))) || "";
  });
  return host ? originFor(host) : null;
}

export async function storefrontCanonical(slug: string): Promise<string> {
  const host = await cachedTagged<string>(`sfcanon:v1:${slug}`, [canonTag(slug)], 300, async () => {
    const sf = await prisma.storefront.findUnique({ where: { slug }, select: { id: true } });
    return (sf && (await primaryActiveHost(sf.id))) || platformSubdomainHost(slug);
  });
  return originFor(host);
}

/** Purge host + canonical caches for a storefront's hosts (call after any domain state change). */
export async function invalidateStorefrontHosts(storefrontId: string, extraHosts: string[] = []): Promise<void> {
  const [sf, domains] = await Promise.all([
    prisma.storefront.findUnique({ where: { id: storefrontId }, select: { slug: true } }),
    prisma.storefrontDomain.findMany({ where: { storefrontId }, select: { hostname: true } }),
  ]);
  const hosts = new Set([...domains.map((d) => d.hostname), ...extraHosts]);
  const tags = [...hosts].map(hostTag);
  if (sf) tags.push(hostTag(platformSubdomainHost(sf.slug)), canonTag(sf.slug));
  await invalidateTags(tags);
}
