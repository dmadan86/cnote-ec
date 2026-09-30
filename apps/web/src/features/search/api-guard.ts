import "server-only";
import { rateLimit } from "@cnote/core";
import { NextResponse, type NextRequest } from "next/server";

/** Every response from the voice/photo routes: personal data in, nothing cacheable out. */
export const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } as const;

export const fail = (status: number, code: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error: code, ...extra }, { status, headers: NO_STORE });

/** Spoof-safe client IP (see @cnote/security clientIp). Used only as a rate-limit key, never stored. */
export function clientIp(req: NextRequest): string {
  return ipFromHeaders(req.headers) ?? "unknown";
}

/**
 * Per-IP fixed-window limit. Fails CLOSED (503) if Redis is unreachable: these routes call paid model vendors, so an outage
 * of the limiter must not become an open tap. Returns a response to send, or null to continue.
 */
export async function limited(req: NextRequest, name: string, limit: number, windowSeconds: number): Promise<NextResponse | null> {
  try {
    if (await rateLimit(`search:${name}:${clientIp(req)}`, limit, windowSeconds)) return null;
    return fail(429, "rate_limited", { retryAfterSeconds: windowSeconds });
  } catch {
    return fail(503, "unavailable");
  }
}

/** Rejects on the declared body size before reading it (multipart bodies are buffered by req.formData()). */
export function tooLarge(req: NextRequest, maxBytes: number): boolean {
  const n = Number(req.headers.get("content-length"));
  return Number.isFinite(n) && n > maxBytes;
}

import { LANGS, type SearchLang } from "./lang";
import { clientIp as ipFromHeaders } from "@cnote/security/client-ip";
export { LANGS, type SearchLang };
export const asLang = (v: unknown): SearchLang => (typeof v === "string" && (LANGS as readonly string[]).includes(v) ? (v as SearchLang) : "en");
