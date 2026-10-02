// Client IP for rate limiting and audit, safe against spoofing (dependency-free: usable from proxy/edge code).
//
// Never trust the FIRST X-Forwarded-For entry: proxies (Cloudflare, load balancers, ingress) append to the header the
// client sent, so the first entry is whatever the client chose, and a spoofed value per request would dodge every
// per-IP rate limit. Order of trust:
//   1. cf-connecting-ip: set by Cloudflare, which overwrites any client-supplied value. HONOURED ONLY when
//      TRUST_CLOUDFLARE=1 (production deploys behind Cloudflare set it; the origin must only accept Cloudflare traffic,
//      see docs/ops/deploy.md). Anywhere else the header is plain client input and is ignored.
//   2. X-Forwarded-For counted from the RIGHT: the entry added by our own outermost trusted proxy. TRUSTED_PROXY_HOPS
//      (default 1) is the number of proxies we run in front of the app.
//   3. x-real-ip: set by the ingress.
interface HeaderSource {
  get(name: string): string | null | undefined;
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
const clean = (v: string | null | undefined): string | null => {
  const s = v?.trim();
  return s && IP_RE.test(s) ? s : null;
};

export function clientIp(h: HeaderSource, env: Record<string, string | undefined> = process.env): string | null {
  if (env.TRUST_CLOUDFLARE === "1") {
    const cf = clean(h.get("cf-connecting-ip"));
    if (cf) return cf;
  }
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const hops = Math.max(1, Math.trunc(Number(env.TRUSTED_PROXY_HOPS ?? 1)) || 1);
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    // A chain shorter than TRUSTED_PROXY_HOPS means the request skipped part of our proxy chain: never fall back to the
    // first (client-controlled) entry. The rightmost entry was appended by our nearest proxy, so it is the safest pick.
    const idx = parts.length - hops;
    const picked = clean(parts[idx >= 0 ? idx : parts.length - 1]);
    if (picked) return picked;
  }
  return clean(h.get("x-real-ip"));
}
