// DNS-pinned outbound fetch (SSRF TOCTOU fix, security audit). `assertPublicHttpTarget` resolves the hostname ONCE and
// rejects private/link-local/loopback/metadata ranges; this fetch then connects to exactly that validated address (an
// undici Agent with a custom `lookup`), so a DNS-rebinding answer between the check and the connect cannot redirect the
// request to an internal host. TLS SNI and the Host header still carry the original hostname.
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

/** A URL together with the one public address it was validated against. */
export interface PublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type PinnedInit = Omit<RequestInit, "redirect" | "dispatcher"> & { timeoutMs?: number };

/** Builds the `lookup` function that always answers with the pinned address, whatever name is asked for. */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (_hostname: string, options: { all?: boolean } | undefined, cb: (err: Error | null, address: unknown, family?: number) => void): void => {
    if (options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Reads at most `max` bytes of the body (aborting the stream beyond that) so a hostile host cannot make us buffer unboundedly. */
async function readCapped(res: { body: unknown }, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error("response too large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * fetch() against a validated target. Redirects are never followed (a redirect target would be unvalidated); the caller
 * sees the 3xx. The agent is single-use and closed afterwards, so the pin never leaks into another request.
 */
export async function pinnedFetch(target: PublicTarget, init: PinnedInit = {}): Promise<Response> {
  const agent = new Agent({ connect: { lookup: pinnedLookup(target.address, target.family) as never }, connections: 1 });
  try {
    const { timeoutMs, ...rest } = init;
    const res = await undiciFetch(target.url, {
      ...(rest as UndiciRequestInit),
      redirect: "manual",
      dispatcher: agent,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs ?? 10_000),
    });
    // Buffer the body before the agent closes (callers read small JSON/ack bodies; cap to keep memory bounded).
    const buf = await readCapped(res, MAX_BODY_BYTES);
    const nullBody = [101, 204, 205, 304].includes(res.status);
    return new Response(nullBody ? null : (buf as unknown as BodyInit), { status: res.status, statusText: res.statusText, headers: res.headers as unknown as HeadersInit });
  } finally {
    await agent.close();
  }
}
