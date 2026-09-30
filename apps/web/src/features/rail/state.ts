/**
 * Persisted rail state. The `cnote_rail` cookie is the store; the live state is `<html data-rail="expanded|collapsed">`,
 * which the rail's CSS keys off. The cookie is applied to the attribute by RAIL_SCRIPT before first paint, so public
 * pages stay static/CDN-cacheable (nothing reads the cookie on the server).
 */
export const RAIL_COOKIE = "cnote_rail";
export type RailState = "expanded" | "collapsed";

export const parseRailState = (v: string | undefined | null): RailState => (v === "expanded" ? "expanded" : "collapsed");

/** `document.cookie` assignment string: a year, whole site, Lax. */
export const railCookie = (s: RailState): string => `${RAIL_COOKIE}=${s}; path=/; max-age=31536000; SameSite=Lax`;

/** Value of the rail cookie in a `document.cookie` string. */
export const railFromCookieString = (cookie: string): RailState =>
  parseRailState(new RegExp(`(?:^|;\\s*)${RAIL_COOKIE}=([^;]*)`).exec(cookie)?.[1]);

/**
 * Inline script for the document <head>: copies the cookie onto <html data-rail>. Tiny and dependency-free so it can run
 * before first paint. Its sha256 is allow-listed in the web CSP (features/rail/csp.ts), which is what lets it run on the
 * nonce-mode (dynamic) pages too; change the text and the hash follows automatically.
 */
export const RAIL_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)${RAIL_COOKIE}=(expanded|collapsed)/);document.documentElement.dataset.rail=m?m[1]:"collapsed"}catch(e){}})()`;

/** Sets the attribute and persists the choice. */
export function applyRailState(s: RailState, doc: Document = document): void {
  doc.documentElement.dataset.rail = s;
  doc.cookie = railCookie(s);
}
