import "server-only";
import { DomainError } from "@cnote/core";
import { currentSession } from "@cnote/next-kit";
import type { BulkActor } from "@cnote/bulk";

/** Seller-realm actor for route handlers; every bulk call is scoped to this business. */
export async function bulkActor(): Promise<BulkActor> {
  const session = await currentSession();
  if (!session?.business) throw new DomainError("unauthenticated", "Please sign in again");
  if (!session.business.isSeller) throw new DomainError("forbidden", "Seller account required");
  return { personId: session.personId, businessId: session.business.id };
}
