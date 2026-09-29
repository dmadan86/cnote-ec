import type { Tx } from "@cnote/db";
import { EVENT_VERSIONS, type DomainEventPayloads, type DomainEventType } from "./catalog";

/**
 * Append a domain event to the outbox. MUST be called with the same transaction as the state
 * change it describes, so the event exists iff the change committed (ADR-007).
 */
export async function emit<T extends DomainEventType>(
  tx: Tx,
  type: T,
  aggregate: { type: string; id: string },
  payload: DomainEventPayloads[T],
): Promise<void> {
  await tx.domainEvent.create({
    data: {
      type,
      version: EVENT_VERSIONS[type],
      aggregateType: aggregate.type,
      aggregateId: aggregate.id,
      payload: payload as object,
    },
  });
}
