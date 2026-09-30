// Transport-neutral operations for the external agent API (ADR-020), shared by REST routes and MCP tools. Every function acts only as
// the { personId, businessId } of the key's business, and external agents can never confirm a deal: there is deliberately no confirm op.
import * as a2a from "@cnote/a2a";
import { DomainError } from "@cnote/core";
import type { ApiPrincipal, Scope } from "@cnote/developer";

// Not in @cnote/developer's Scope union until the lead adds them (packages/developer/src/scopes.ts); the cast keeps typecheck green before and after.
export const AGENTS_READ: Scope = "agents:read";
export const AGENTS_WRITE: Scope = "agents:write";

export interface Page<T> { items: T[]; nextCursor: string | null }

function paginate<T>(all: T[], cursor: string | undefined, limit: number): Page<T> {
  let offset = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, "base64url").toString();
    offset = /^\d{1,9}$/.test(decoded) ? Number(decoded) : -1;
    if (offset < 0) throw new DomainError("validation", "Invalid cursor");
  }
  const items = all.slice(offset, offset + limit);
  const next = offset + limit;
  return { items, nextCursor: next < all.length ? Buffer.from(String(next)).toString("base64url") : null };
}

export function actor(p: ApiPrincipal): a2a.Actor {
  if (!p.businessId) throw new DomainError("forbidden", "This API key is not bound to a business. Create the key for a business in your account settings.");
  return { personId: p.personId, businessId: p.businessId };
}
const via = (p: ApiPrincipal): a2a.Via => ({ kind: "external_agent", apiKeyId: p.keyId });
const notFound = (what: string) => new DomainError("not_found", `${what} not found`);

export type NegotiationStatus = "open" | "agreed" | "accepted" | "rejected" | "withdrawn" | "expired";

export async function mandates(p: ApiPrincipal, o: { cursor?: string; limit?: number; side?: a2a.Side; status?: string } = {}) {
  const all = await a2a.listMandates(actor(p).businessId, { side: o.side, status: o.status as never });
  return paginate(all, o.cursor, o.limit ?? 25);
}
export async function mandate(p: ApiPrincipal, id: string) {
  const m = await a2a.getMandate(actor(p).businessId, id);
  if (!m) throw notFound("Mandate");
  return m;
}
export async function negotiations(p: ApiPrincipal, o: { cursor?: string; limit?: number; side?: a2a.Side; status?: NegotiationStatus } = {}) {
  const all = await a2a.listNegotiations(actor(p).businessId, { side: o.side, status: o.status, limit: 200 });
  return paginate(all, o.cursor, o.limit ?? 25);
}
export async function negotiation(p: ApiPrincipal, id: string) {
  const n = await a2a.getNegotiation(actor(p), id);
  if (!n) throw notFound("Negotiation");
  return n;
}
export function start(p: ApiPrincipal, input: { mandateId: string; matchId: string }, startKey?: string | null) {
  return a2a.startNegotiation(actor(p), { ...input, startKey: startKey || null }, via(p));
}
export function send(p: ApiPrincipal, id: string, message: a2a.ProtocolMessageInput, idempotencyKey: string) {
  const key = (idempotencyKey ?? "").trim();
  if (!key) throw new DomainError("validation", "An Idempotency-Key is required when sending a negotiation message.");
  return a2a.sendNegotiationMessage(actor(p), id, message, { idempotencyKey: key, via: via(p) });
}
