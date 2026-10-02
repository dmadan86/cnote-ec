// Unauthenticated webhook bodies are read as a STREAM and aborted once they pass the cap, so a sender that omits or lies
// about Content-Length (chunked transfer) cannot make us buffer an unbounded body before the HMAC is even checked
// (security audit, payments hardening). Returns null when the body exceeds `max` bytes.
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}
