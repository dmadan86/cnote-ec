import { pickTrafficParams, recordHit, resolveHost, type HostKind } from "@cnote/domains";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@cnote/security/client-ip";

// Custom-domain + platform-subdomain routing for storefronts, called from src/proxy.ts (see docs/design/custom-domains.md).
// Platform hosts (the marketplace itself) are answered by resolveHost without any I/O and pass through untouched.

/** Paths that must keep working on a storefront host exactly as on the marketplace (assets, media, APIs, probes). */
const PASS_THROUGH = [/^\/_next\//, /^\/media\//, /^\/api\//, /^\/\.well-known\//, /^\/favicon\.ico$/, /^\/icon[^/]*$/, /^\/apple-icon[^/]*$/];

function hostOf(req: NextRequest): string {
  const raw = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return raw.split(",")[0]!.trim().toLowerCase().replace(/:\d+$/, "");
}

const isLocal = (host: string) => host === "localhost" || host.endsWith(".localhost");

/**
 * - custom domain / <slug>.<root> subdomain, host is the storefront's primary  -> rewrite to /store/<slug>/…
 * - custom domain / subdomain that is NOT the primary                            -> 301 to the primary host
 * - platform or unknown hosts                                                    -> null (proxy continues normally)
 * Any /store/… path typed on a storefront host is prefixed too, so it 404s rather than exposing another storefront.
 */
export async function routeStorefrontHost(req: NextRequest): Promise<NextResponse | null> {
  const host = hostOf(req);
  let resolved;
  try {
    resolved = await resolveHost(host);
  } catch (err) {
    console.error("[domains] resolveHost failed", err instanceof Error ? err.message : err);
    return null;
  }
  if (!resolved || resolved.kind === "platform") return null;

  const { pathname, search } = req.nextUrl;
  if (resolved.canonicalHost !== host && !PASS_THROUGH.some((re) => re.test(pathname))) {
    const proto = isLocal(resolved.canonicalHost) ? "http" : "https";
    const port = isLocal(resolved.canonicalHost) && req.nextUrl.port ? `:${req.nextUrl.port}` : "";
    return NextResponse.redirect(`${proto}://${resolved.canonicalHost}${port}${pathname}${search}`, 301);
  }
  if (PASS_THROUGH.some((re) => re.test(pathname))) return null;

  const url = req.nextUrl.clone();
  url.pathname = `/store/${resolved.storefrontSlug}${pathname === "/" ? "" : pathname}`;
  const headers = new Headers(req.headers);
  headers.set("x-storefront-slug", resolved.storefrontSlug);
  headers.set("x-storefront-host", host);
  headers.set("x-storefront-canonical-host", resolved.canonicalHost);
  return NextResponse.rewrite(url, { request: { headers } });
}

const STORE_PATH = /^\/store\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(\/.*)?$/;

/**
 * Meter one request (requests, page views, source, device, bots, visitors). Fire-and-forget: never awaited, never throws,
 * one Redis round-trip. Call it for every request that reaches the proxy, before/alongside routing.
 */
export function recordStorefrontHit(req: NextRequest): void {
  void (async () => {
    try {
      if (req.headers.get("next-router-prefetch") || req.headers.get("purpose") === "prefetch" || req.headers.get("sec-purpose")?.includes("prefetch")) return;
      const host = hostOf(req);
      const { pathname, searchParams } = req.nextUrl;
      const resolved = await resolveHost(host);
      let slug: string | null = null;
      let hostKind: HostKind = "path";
      let path = pathname;
      if (resolved && resolved.kind !== "platform") {
        slug = resolved.storefrontSlug;
        hostKind = resolved.kind;
      } else if (resolved?.kind === "platform") {
        const m = STORE_PATH.exec(pathname);
        if (m) {
          slug = m[1]!;
          path = m[2] || "/";
        }
      }
      if (!slug) return;
      const fwd = clientIp(req.headers);
      await recordHit({
        host,
        path,
        referrer: req.headers.get("referer"),
        userAgent: req.headers.get("user-agent"),
        ip: fwd,
        utm: pickTrafficParams(searchParams),
        storefrontSlug: slug,
        hostKind,
        ownHosts: resolved && resolved.kind !== "platform" ? [resolved.canonicalHost] : [],
      });
    } catch (err) {
      console.error("[domains] recordStorefrontHit failed", err instanceof Error ? err.message : err);
    }
  })();
}
