import type Redis from "ioredis";
import { blockingConnection, redis as defaultRedis } from "../redis";
import type { DomainEvent } from "./catalog";

/**
 * Pub/sub transport for domain events (observer pattern): every subscribing module (consumer
 * group) sees every event. Selected by QUEUE_DRIVER like the JobQueue; Kafka slots in here.
 */
export interface EventTransport {
  readonly driver: string;
  publish(events: DomainEvent[]): Promise<void>;
  /** Deliver one batch to `group`; ack only when `handle` resolves (at-least-once). */
  consume(group: string, consumer: string, handle: (event: DomainEvent) => Promise<void>, opts?: { count?: number; blockMs?: number }): Promise<number>;
}

export const EVENT_STREAM = "cnote:events";
type StreamRead = [string, [string, string[]][]][] | null;

export class RedisEventTransport implements EventTransport {
  readonly driver = "redis";
  private groups = new Set<string>();

  constructor(private redis: Redis = defaultRedis, private stream = EVENT_STREAM) {}

  async publish(events: DomainEvent[]) {
    if (!events.length) return;
    const p = this.redis.pipeline();
    for (const e of events) p.xadd(this.stream, "*", "event", JSON.stringify(e));
    await p.exec();
  }

  async consume(group: string, consumer: string, handle: (event: DomainEvent) => Promise<void>, opts: { count?: number; blockMs?: number } = {}) {
    await this.ensureGroup(group);
    // Retry this consumer's own pending (unacked) messages first, then read new ones.
    let res = (await this.redis.xreadgroup("GROUP", group, consumer, "COUNT", opts.count ?? 50, "STREAMS", this.stream, "0")) as StreamRead;
    if (!res?.[0]?.[1]?.length) {
      // Blocking read on its own connection: on the shared client it would stall publish (and everything else) until it returns.
      const reader = blockingConnection(this.redis, `events:${group}:${consumer}`);
      res = (await reader.xreadgroup("GROUP", group, consumer, "COUNT", opts.count ?? 50, "BLOCK", opts.blockMs ?? 1000, "STREAMS", this.stream, ">")) as StreamRead;
    }
    let handled = 0;
    for (const [id, fields] of res?.[0]?.[1] ?? []) {
      const event = JSON.parse(fields[1] ?? "{}") as DomainEvent;
      try {
        await handle(event);
        await this.redis.xack(this.stream, group, id);
        handled++;
      } catch (err) {
        console.error(`[events] ${group} failed on ${event.type}#${event.id}`, err);
      }
    }
    return handled;
  }

  private async ensureGroup(group: string) {
    if (this.groups.has(group)) return;
    try {
      await this.redis.xgroup("CREATE", this.stream, group, "0", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    this.groups.add(group);
  }
}

/** In-process fan-out for tests: each group keeps its own cursor over the published log. */
export class MemoryEventTransport implements EventTransport {
  readonly driver = "memory";
  readonly log: DomainEvent[] = [];
  private cursors = new Map<string, number>();

  async publish(events: DomainEvent[]) {
    this.log.push(...events);
  }

  async consume(group: string, _consumer: string, handle: (event: DomainEvent) => Promise<void>, opts: { count?: number } = {}) {
    const from = this.cursors.get(group) ?? 0;
    const batch = this.log.slice(from, from + (opts.count ?? 50));
    let handled = 0;
    for (const e of batch) {
      await handle(e); // on throw the cursor stays put → redelivered next call
      this.cursors.set(group, from + ++handled);
    }
    return handled;
  }
}

export function createEventTransport(driver: string): EventTransport {
  switch (driver) {
    case "redis":
      return new RedisEventTransport();
    case "memory":
      return new MemoryEventTransport();
    case "kafka":
      throw new Error("QUEUE_DRIVER=kafka is not implemented yet — see packages/core/src/events/transport.ts");
    default:
      throw new Error(`unknown QUEUE_DRIVER ${driver}`);
  }
}

let instance: EventTransport | undefined;
export function getEventTransport(): EventTransport {
  return (instance ??= createEventTransport(process.env.QUEUE_DRIVER ?? "redis"));
}
export function setEventTransport(t: EventTransport | undefined) {
  instance = t;
}
