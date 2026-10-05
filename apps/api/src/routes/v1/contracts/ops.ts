// Transport-neutral operations for the rate-contract API (docs/design/rate-contracts.md). Every function acts only as the
// { personId, businessId } of the key's business; the domain module re-checks ownership. Call-offs are buyer-only, and creating,
// changing and accepting contracts is deliberately NOT exposed: it needs the business's people in the app.
import { DomainError } from "@cnote/core";
import type { ApiPrincipal } from "@cnote/developer";
import * as enquiry from "@cnote/enquiry";

export interface Page<T> { items: T[]; nextCursor: string | null }

function actor(p: ApiPrincipal): enquiry.Actor {
  if (!p.businessId) throw new DomainError("forbidden", "This API key is not bound to a business. Create the key for a business in your account settings.");
  return { personId: p.personId, businessId: p.businessId };
}

export async function list(p: ApiPrincipal, q: { role: "buyer" | "seller"; status?: enquiry.RcStatus; cursor?: string; limit?: number }): Promise<Page<enquiry.RateContractRow>> {
  enquiry.assertRateContractsEnabled();
  return enquiry.listRateContracts(actor(p), { role: q.role, status: q.status ?? null, cursor: q.cursor ?? null, limit: q.limit ?? 25 });
}

export async function get(p: ApiPrincipal, id: string): Promise<enquiry.RateContractView> {
  enquiry.assertRateContractsEnabled();
  const c = await enquiry.getRateContract(actor(p), id);
  if (!c) throw new DomainError("not_found", "Rate contract not found");
  return c;
}

export async function callOff(p: ApiPrincipal, id: string, input: enquiry.CallOffInput) {
  const key = (input.idempotencyKey ?? "").trim();
  if (!key) throw new DomainError("validation", "An Idempotency-Key header is required when placing a call-off.");
  const r = await enquiry.placeCallOff(actor(p), id, { ...input, idempotencyKey: key });
  return {
    callOff: r.callOff,
    orderId: r.orderId,
    purchaseOrder: r.purchaseOrder ? { id: r.purchaseOrder.id, number: r.purchaseOrder.number, status: r.purchaseOrder.status, totalPaise: r.purchaseOrder.totals.totalPaise } : null,
    purchaseOrderError: r.purchaseOrderError,
    contract: r.contract,
  };
}
