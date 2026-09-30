import { createHash } from "node:crypto";
import { RAIL_SCRIPT } from "./state";

/** CSP source expression for RAIL_SCRIPT ('sha256-...'). Node-only: import from the proxy and next.config, never a client module. */
export const RAIL_SCRIPT_CSP_SOURCE = `'sha256-${createHash("sha256").update(RAIL_SCRIPT).digest("base64")}'`;

/**
 * Extra CSP option for NONCE-mode responses only (dynamic pages: 'nonce-…' + 'strict-dynamic'), where an un-nonced inline
 * script would otherwise be blocked. Never pass it in static mode: a hash/nonce in script-src makes browsers ignore
 * 'unsafe-inline', which would block Next's own inline hydration scripts on static/ISR pages (those already allow inline).
 */
export const WEB_NONCE_SECURITY: { app: "web"; allow: { scripts: string[] } } = { app: "web", allow: { scripts: [RAIL_SCRIPT_CSP_SOURCE] } };
