import type { DomainEvent, DomainEventPayloads, DomainEventType } from "@cnote/core";
import type { Tx } from "@cnote/db";

/**
 * A CDC-style read-model projection over the domain event log. `process` receives a batch of this projection's event types
 * in id order INSIDE the transaction that also advances the checkpoint, so every effect is applied exactly once even though
 * the run may be retried, restarted or run by several workers (a row lock lets exactly one win).
 */
export interface Projection {
  name: string;
  /** bump when the projection's logic or tables change shape: requires `backfill --reset` */
  version: number;
  types: readonly DomainEventType[];
  /** projections that must be ahead of this one (this one never passes their checkpoint) */
  dependsOn?: readonly string[];
  process(tx: Tx, events: DomainEvent[]): Promise<void>;
  /** wipe every table the projection owns (backfill --reset) */
  reset(tx: Tx): Promise<void>;
}

export type PayloadOf<T extends DomainEventType> = DomainEventPayloads[T];
export const payload = <T extends DomainEventType>(e: DomainEvent): PayloadOf<T> => e.payload as PayloadOf<T>;
