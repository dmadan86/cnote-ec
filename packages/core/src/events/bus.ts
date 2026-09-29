import { prisma } from "@cnote/db";
import type { DomainEvent, DomainEventType } from "./catalog";
import { getEventTransport, type EventTransport } from "./transport";

export type EventHandler<T extends DomainEventType = DomainEventType> = (event: DomainEvent<T>) => Promise<void>;
/** Per-module handler map (observers). Handlers must be idempotent: delivery is at-least-once. */
export type EventHandlers = { [K in DomainEventType]?: EventHandler<K> };

/**
 * Relay unpublished outbox rows to the event transport, oldest first. Safe to run concurrently
 * (FOR UPDATE SKIP LOCKED). Returns number relayed.
 */
export async function relayOutbox(batchSize = 200, transport: EventTransport = getEventTransport()): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: bigint; type: string; version: number; aggregate_type: string; aggregate_id: string; payload: unknown; occurred_at: Date }[]
    >`SELECT id, type, version, aggregate_type, aggregate_id, payload, occurred_at
      FROM domain_events WHERE published_at IS NULL ORDER BY id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;
    await transport.publish(
      rows.map((r) => ({
        id: Number(r.id),
        type: r.type as DomainEventType,
        version: r.version,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        payload: r.payload as never,
        occurredAt: r.occurred_at.toISOString(),
      })),
    );
    await tx.$executeRaw`UPDATE domain_events SET published_at = now() WHERE id = ANY(${rows.map((r) => r.id)})`;
    return rows.length;
  });
}

/** Deliver one batch of events to a module's handlers as consumer group `group`. */
export async function consumeOnce(
  group: string,
  consumer: string,
  handlers: EventHandlers,
  opts: { count?: number; blockMs?: number; transport?: EventTransport } = {},
): Promise<number> {
  const transport = opts.transport ?? getEventTransport();
  return transport.consume(
    group,
    consumer,
    async (event) => {
      const handler = handlers[event.type] as EventHandler | undefined;
      if (handler) await handler(event);
    },
    opts,
  );
}
