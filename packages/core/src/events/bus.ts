import { prisma } from "@cnote/db";
import type Redis from "ioredis";
import { redis as defaultRedis } from "../redis";
import type { DomainEvent, DomainEventType } from "./catalog";

export const EVENT_STREAM = "cnote:events";

export type EventHandler<T extends DomainEventType = DomainEventType> = (event: DomainEvent<T>) => Promise<void>;
/** Per-module handler map. Handlers must be idempotent: delivery is at-least-once. */
export type EventHandlers = { [K in DomainEventType]?: EventHandler<K> };

/**
 * Relay unpublished outbox rows to the Redis stream, oldest first. Safe to run concurrently
 * (FOR UPDATE SKIP LOCKED). Returns number relayed.
 */
export async function relayOutbox(batchSize = 200, redis: Redis = defaultRedis): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: bigint; type: string; version: number; aggregate_type: string; aggregate_id: string; payload: unknown; occurred_at: Date }[]
    >`SELECT id, type, version, aggregate_type, aggregate_id, payload, occurred_at
      FROM domain_events WHERE published_at IS NULL ORDER BY id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;
    const pipeline = redis.pipeline();
    for (const r of rows) {
      const event: DomainEvent = {
        id: Number(r.id),
        type: r.type as DomainEventType,
        version: r.version,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        payload: r.payload as never,
        occurredAt: r.occurred_at.toISOString(),
      };
      pipeline.xadd(EVENT_STREAM, "*", "event", JSON.stringify(event));
    }
    await pipeline.exec();
    await tx.$executeRaw`UPDATE domain_events SET published_at = now() WHERE id = ANY(${rows.map((r) => r.id)})`;
    return rows.length;
  });
}

/**
 * Consume the stream as consumer group `group` (one group per module), dispatching to handlers.
 * Acks only after the handler succeeds; failed messages stay pending and are retried.
 */
export async function consumeOnce(
  group: string,
  consumer: string,
  handlers: EventHandlers,
  opts: { count?: number; blockMs?: number; redis?: Redis } = {},
): Promise<number> {
  const redis = opts.redis ?? defaultRedis;
  await ensureGroup(redis, group);
  // Retry this consumer's own pending (unacked) messages first, then read new ones.
  let res = (await redis.xreadgroup("GROUP", group, consumer, "COUNT", opts.count ?? 50, "STREAMS", EVENT_STREAM, "0")) as StreamRead;
  if (!res?.[0]?.[1]?.length) {
    res = (await redis.xreadgroup(
      "GROUP", group, consumer, "COUNT", opts.count ?? 50, "BLOCK", opts.blockMs ?? 1000, "STREAMS", EVENT_STREAM, ">",
    )) as StreamRead;
  }
  const entries = res?.[0]?.[1] ?? [];
  let handled = 0;
  for (const [id, fields] of entries) {
    const event = JSON.parse(fields[1] ?? "{}") as DomainEvent;
    const handler = handlers[event.type] as EventHandler | undefined;
    try {
      if (handler) await handler(event);
      await redis.xack(EVENT_STREAM, group, id);
      handled++;
    } catch (err) {
      console.error(`[events] ${group} failed on ${event.type}#${event.id}`, err);
    }
  }
  return handled;
}

type StreamRead = [string, [string, string[]][]][] | null;

const knownGroups = new Set<string>();
async function ensureGroup(redis: Redis, group: string) {
  if (knownGroups.has(group)) return;
  try {
    await redis.xgroup("CREATE", EVENT_STREAM, group, "0", "MKSTREAM");
  } catch (err) {
    if (!String(err).includes("BUSYGROUP")) throw err;
  }
  knownGroups.add(group);
}
