/**
 * Request rules of the service worker (public/sw.js), kept here as the typed, unit-tested source of truth (ADR-004: low
 * bandwidth). public/sw.js is plain JavaScript (a worker cannot import this module without a build step), so it carries a
 * copy of exactly these functions; test/pwa-sw.test.ts runs sw.js in a sandbox and asserts both agree on every case, so
 * the two cannot drift. Change both together.
 *
 *   - Only same-origin GETs are ever handled; everything else (POST, server actions, cross-origin, Range) goes to the network.
 *   - /api, authentication and the signed-in areas are never cached.
 *   - /_next/static (fingerprinted, immutable) and images: cache first.
 *   - Navigations: network first; on failure the cached copy (help pages only) or the /offline fallback page.
 */

export type SwStrategy = "bypass" | "static" | "image" | "navigate";

/** Paths that are personal or transactional: never intercepted, so nothing of them can end up in a cache. */
export const PRIVATE_PREFIXES = ["/api", "/account", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare", "/onboarding", "/signin", "/signup", "/forgot-password", "/reset-password", "/grievance", "/preview", "/r/", "/ad/"] as const;

/** Navigations whose last good copy may be served when the network is down (public, static, locale-aware). */
export const CACHEABLE_NAVIGATION_PREFIXES = ["/help", "/hi/help", "/offline", "/hi/offline"] as const;

export const OFFLINE_PATHS = { en: "/offline", hi: "/hi/offline" } as const;

export interface SwRequestInfo {
  method: string;
  url: string;
  /** Request.mode ("navigate" for page loads). */
  mode: string;
  /** Request.destination ("image", "script", "document", ...). */
  destination: string;
  /** The worker's own origin (self.location.origin). */
  origin: string;
  /** Whether the request carries a Range header (media streaming): left to the browser. */
  range?: boolean;
}

const startsWithPath = (path: string, prefix: string) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`));

export const isPrivatePath = (path: string) => PRIVATE_PREFIXES.some((p) => startsWithPath(path, p));
export const isCacheableNavigation = (path: string) => CACHEABLE_NAVIGATION_PREFIXES.some((p) => startsWithPath(path, p));

/** The offline page for the language of the path being visited (Hindi under /hi, else English). */
export const offlineFor = (path: string): string => (startsWithPath(path, "/hi") ? OFFLINE_PATHS.hi : OFFLINE_PATHS.en);

export function classify(req: SwRequestInfo): SwStrategy {
  if (req.method !== "GET" || req.range) return "bypass";
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== req.origin) return "bypass";
  const path = url.pathname;
  if (isPrivatePath(path)) return "bypass";
  if (path === "/sw.js" || path === "/manifest.webmanifest") return "bypass";
  if (path.startsWith("/_next/static/")) return "static";
  if (req.destination === "image" || path.startsWith("/_next/image")) return "image";
  if (req.mode === "navigate") return "navigate";
  return "bypass";
}
