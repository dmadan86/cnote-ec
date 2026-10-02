import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeOnce, createEventTransport, emit, EVENT_VERSIONS, getEventTransport, MemoryEventTransport, RedisEventTransport, relayOutbox, setEventTransport } from "../src/events";
import type { DomainEvent } from "../src/events";
import { redis } from "../src/redis";

const ev = (id: number, type = "BusinessCreated"): DomainEvent =>
  ({ id, type, version: 1, aggregateType: "business", aggregateId: `b${id}`, payload: { businessId: `b${id}` }, occurredAt: "2026-01-01T00:00:00.000Z" }) as unknown as DomainEvent;

afterAll(async () => {
  await prisma.$disconnect();
});

describe("EVENT_VERSIONS", () => {
  it("every event type has a positive integer version", () => {
    for (const [t, v] of Object.entries(EVENT_VERSIONS)) {
      expect(Number.isInteger(v), t).toBe(true);
      expect(v, t).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("MemoryEventTransport", () => {
  it("honours count, keeps per-group cursors, and only advances past successfully handled events", async () => {
    const t = new MemoryEventTransport();
    await t.publish([ev(1), ev(2), ev(3)]);
    const seen: number[] = [];
    expect(await t.consume("g", "c", async (e) => void seen.push(e.id), { count: 2 })).toBe(2);
    expect(await t.consume("g", "c", async (e) => void seen.push(e.id), { count: 2 })).toBe(1);
    expect(await t.consume("g", "c", async (e) => void seen.push(e.id))).toBe(0);
    expect(seen).toEqual([1, 2, 3]);

    // partial failure: first handled, second throws -> cursor after first only
    await t.publish([ev(4), ev(5)]);
    await expect(
      t.consume("g", "c", async (e) => {
        if (e.id === 5) throw new Error("x");
      }),
    ).rejects.toThrow();
    const redelivered: number[] = [];
    await t.consume("g", "c", async (e) => void redelivered.push(e.id));
    expect(redelivered).toEqual([5]);
  });
});

describe("RedisEventTransport", () => {
  let stream: string;
  let t: RedisEventTransport;
  beforeEach(() => {
    stream = `cnote:test:events:${randomUUID()}`;
    t = new RedisEventTransport(redis, stream);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await redis.del(stream);
  });
  const run = (group: string, h: (e: DomainEvent) => Promise<void>, consumer = "c", count = 50) => t.consume(group, consumer, h, { blockMs: 5, count });

  it("publish of an empty batch is a no-op", async () => {
    await t.publish([]);
    expect(await redis.exists(stream)).toBe(0);
  });

  it("fans out to every group and round-trips the payload", async () => {
    await t.publish([ev(1), ev(2)]);
    const a: DomainEvent[] = [];
    const b: DomainEvent[] = [];
    expect(await run("a", async (e) => void a.push(e))).toBe(2);
    expect(await run("b", async (e) => void b.push(e))).toBe(2);
    expect(a).toEqual([ev(1), ev(2)]);
    expect(b).toEqual(a);
    expect(await run("a", async () => undefined)).toBe(0);
  });

  it("a failing handler is not acked: it is redelivered, the rest of the batch still runs", async () => {
    await t.publish([ev(1), ev(2), ev(3)]);
    const first: number[] = [];
    const handled = await run("g", async (e) => {
      if (e.id === 2) throw new Error("bad");
      first.push(e.id);
    });
    expect(handled).toBe(2);
    expect(first).toEqual([1, 3]);
    const again: number[] = [];
    expect(await run("g", async (e) => void again.push(e.id))).toBe(1);
    expect(again).toEqual([2]);
    expect(await run("g", async () => undefined)).toBe(0);
  });

  it("creates the group idempotently across instances (BUSYGROUP swallowed)", async () => {
    await t.publish([ev(1)]);
    await run("g", async () => undefined);
    const t2 = new RedisEventTransport(redis, stream);
    expect(await t2.consume("g", "c", async () => undefined, { blockMs: 5 })).toBe(0);
  });

  it("competing consumers in a group process each event exactly once", async () => {
    await t.publish(Array.from({ length: 40 }, (_, i) => ev(i + 1)));
    const seen: number[] = [];
    const w = async (name: string) => {
      for (let i = 0; i < 6; i++) await run("g", async (e) => void seen.push(e.id), name, 5);
    };
    await Promise.all([w("c1"), w("c2")]);
    expect(seen.sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });
});

describe("createEventTransport / getEventTransport", () => {
  afterEach(() => {
    setEventTransport(undefined);
    delete process.env.QUEUE_DRIVER;
  });
  it("factory", () => {
    expect(createEventTransport("memory")).toBeInstanceOf(MemoryEventTransport);
    expect(createEventTransport("redis")).toBeInstanceOf(RedisEventTransport);
    expect(() => createEventTransport("kafka")).toThrow(/not implemented/);
    expect(() => createEventTransport("carrier-pigeon")).toThrow(/unknown QUEUE_DRIVER carrier-pigeon/);
  });
  it("singleton follows QUEUE_DRIVER and can be swapped", () => {
    process.env.QUEUE_DRIVER = "memory";
    const a = getEventTransport();
    expect(getEventTransport()).toBe(a);
    const m = new MemoryEventTransport();
    setEventTransport(m);
    expect(getEventTransport()).toBe(m);
    setEventTransport(undefined);
    delete process.env.QUEUE_DRIVER;
    expect(getEventTransport().driver).toBe("redis");
  });
});

describe("consumeOnce", () => {
  it("routes each event to its type's handler and skips types without one", async () => {
    const t = new MemoryEventTransport();
    await t.publish([ev(1, "BusinessCreated"), ev(2, "PersonRegistered"), ev(3, "BusinessCreated")]);
    const seen: number[] = [];
    const n = await consumeOnce("mod", "c", { BusinessCreated: async (e) => void seen.push(e.id) }, { transport: t });
    expect(n).toBe(3); // unhandled types are still consumed (acked)
    expect(seen).toEqual([1, 3]);
  });
  it("propagates handler failures (memory transport keeps the cursor for redelivery)", async () => {
    const t = new MemoryEventTransport();
    await t.publish([ev(1)]);
    await expect(consumeOnce("mod", "c", { BusinessCreated: async () => Promise.reject(new Error("no")) }, { transport: t })).rejects.toThrow("no");
    const seen: number[] = [];
    await consumeOnce("mod", "c", { BusinessCreated: async (e) => void seen.push(e.id) }, { transport: t });
    expect(seen).toEqual([1]);
  });
  it("defaults to the process-wide transport", async () => {
    const t = new MemoryEventTransport();
    setEventTransport(t);
    await t.publish([ev(1)]);
    expect(await consumeOnce("mod", "c", {})).toBe(1);
    setEventTransport(undefined);
  });
});

// The outbox tables are shared with every other package's tests in the isolated test DB, so this suite
// tags its rows with a unique aggregate type and puts back any foreign rows a relay happened to publish.
describe("outbox: emit + relayOutbox (real Postgres)", () => {
  const agg = `t-core-${randomUUID().slice(0, 8)}`;
  const mine = (log: DomainEvent[]) => log.filter((e) => e.aggregateType === agg);

  async function restoreForeign(log: DomainEvent[]) {
    const foreign = log.filter((e) => e.aggregateType !== agg).map((e) => BigInt(e.id));
    if (foreign.length) await prisma.$executeRaw`UPDATE domain_events SET published_at = NULL WHERE id = ANY(${foreign})`;
  }
  /**
   * Relays until everything unpublished (including other suites' leftover events in the shared test DB) has passed
   * through, then restores the foreign rows. A single 10k batch is not enough once the test DB has accumulated events.
   */
  async function drain(expectedMine?: number): Promise<DomainEvent[]> {
    const t = new MemoryEventTransport();
    // With `expectedMine`, stop once all of this suite's rows were seen: other packages keep emitting into the shared DB, so
    // "until nothing is unpublished" may never be reached while they run.
    while ((await relayOutbox(10_000, t)) > 0 && (expectedMine === undefined || mine(t.log).length < expectedMine));
    await restoreForeign(t.log);
    return t.log;
  }
  const seed = (n: number) =>
    prisma.$transaction(async (tx) => {
      for (let i = 0; i < n; i++) await emit(tx, "BusinessCreated", { type: agg, id: `${i}` }, { businessId: `${agg}-${i}`, personId: "p", isSeller: i % 2 === 0 });
    });
  afterEach(async () => {
    await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_type = ${agg}`;
  });

  it("emit stores type, current version, aggregate and payload; rolls back with its transaction", async () => {
    await seed(1);
    const row = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateType: agg } });
    expect(row).toMatchObject({ type: "BusinessCreated", version: EVENT_VERSIONS.BusinessCreated, aggregateId: "0", publishedAt: null });
    expect(row.payload).toEqual({ businessId: `${agg}-0`, personId: "p", isSeller: true });

    await expect(
      prisma.$transaction(async (tx) => {
        await emit(tx, "PersonRegistered", { type: agg, id: "rb" }, { personId: "x", phone: "y" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await prisma.domainEvent.count({ where: { aggregateType: agg, aggregateId: "rb" } })).toBe(0);
  });

  it("relays oldest-first, marks rows published, and never relays a row twice", async () => {
    await seed(5);
    const t = { log: await drain(5) };
    const ids = mine(t.log).map((e) => e.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(mine(t.log)[0]).toMatchObject({ type: "BusinessCreated", version: 1, aggregateType: agg, payload: { businessId: `${agg}-0` } });
    expect(Number.isNaN(Date.parse(mine(t.log)[0]!.occurredAt))).toBe(false);
    expect(await prisma.domainEvent.count({ where: { aggregateType: agg, publishedAt: null } })).toBe(0);
    expect(mine(await drain())).toHaveLength(0);
  });

  it("respects batchSize", async () => {
    await seed(4);
    const t = new MemoryEventTransport();
    expect(await relayOutbox(1, t)).toBe(1);
    await restoreForeign(t.log);
  });

  it("a transport failure rolls back: rows stay unpublished and are retried", async () => {
    await seed(3);
    const failing = { driver: "x", publish: async () => Promise.reject(new Error("down")), consume: async () => 0 };
    await expect(relayOutbox(10_000, failing)).rejects.toThrow("down");
    expect(await prisma.domainEvent.count({ where: { aggregateType: agg, publishedAt: null } })).toBe(3);
    expect(mine(await drain())).toHaveLength(3);
  });

  it("parallel relays (FOR UPDATE SKIP LOCKED) deliver each event exactly once", async () => {
    await seed(30);
    const t = new MemoryEventTransport();
    await Promise.all(Array.from({ length: 6 }, () => relayOutbox(7, t)));
    // drain whatever the batch limit left behind
    while (mine(t.log).length < 30 && (await relayOutbox(7, t)) > 0);
    await restoreForeign(t.log);
    const ids = mine(t.log).map((e) => e.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });
});
