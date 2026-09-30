import "server-only";
import { DomainError } from "@cnote/core";
import { currentSession } from "@cnote/next-kit";

/** Seller actor for the ai-draft route handlers; every call is scoped to this business. */
export async function sellerActor(req: Request): Promise<{ personId: string; businessId: string }> {
  // State-changing POST from our own origin only (defence in depth on top of SameSite=Lax).
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) throw new DomainError("forbidden", "Cross-origin request refused");
  const session = await currentSession();
  if (!session?.business) throw new DomainError("unauthenticated", "Please sign in again");
  if (!session.business.isSeller) throw new DomainError("forbidden", "Seller account required");
  return { personId: session.personId, businessId: session.business.id };
}

export function assertDeclaredSize(req: Request, max: number, message: string): void {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new DomainError("validation", message);
}

/** Reads a raw body, aborting as soon as it exceeds `max` bytes. */
export async function readCapped(req: Request, max: number, message: string): Promise<Uint8Array> {
  assertDeclaredSize(req, max, message);
  if (!req.body) throw new DomainError("validation", "Nothing was uploaded");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new DomainError("validation", message);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
