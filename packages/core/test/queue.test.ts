import { describe, expect, it } from "vitest";
import { MemoryEventTransport } from "../src/events/transport";
import { MemoryJobQueue, RedisJobQueue, retryDelayMs } from "../src/queue";
import { redis } from "../src/redis";

declare module "../src/queue/types" {
  interface JobTopics {
    "test.echo": { n: number };
  }
}

describe("retryDelayMs", () => {
  it("backs off exponentially and caps at 1h", () => {
    const mid = () => 0.5;
    expect(retryDelayMs(1, mid)).toBe(5000);
    expect(retryDelayMs(2, mid)).toBe(25000);
    expect(retryDelayMs(20, mid)).toBe(3_600_000);
  });
});

describe("MemoryJobQueue", () => {
  it("retries with backoff then dead-letters", async () => {
    let now = 0;
    const q = new MemoryJobQueue(() => now);
    await q.enqueue("test.echo", { n: 1 }, { maxAttempts: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    expect(await q.consume("test.echo", "g", "c", fail)).toBe(1);
    now += 3_600_000;
    await q.promoteDelayed("test.echo");
    await q.consume("test.echo", "g", "c", fail);
    const dlq = await q.deadLetters("test.echo");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.attempt).toBe(2);
    expect(await q.replayDeadLetter("test.echo", dlq[0]!.id)).toBe(true);
  });

  it("dedupes by key", async () => {
    const q = new MemoryJobQueue();
    expect(await q.enqueue("test.echo", { n: 1 }, { dedupeKey: "k" })).not.toBeNull();
    expect(await q.enqueue("test.echo", { n: 2 }, { dedupeKey: "k" })).toBeNull();
  });
});

describe("MemoryEventTransport", () => {
  it("fans out every event to every group and redelivers on failure", async () => {
    const t = new MemoryEventTransport();
    const e = { id: 1, type: "BusinessCreated", version: 1, aggregateType: "business", aggregateId: "b", payload: {}, occurredAt: "" } as never;
    await t.publish([e]);
    const seen: string[] = [];
    await t.consume("a", "c", async () => void seen.push("a"));
    await t.consume("b", "c", async () => void seen.push("b"));
    expect(seen).toEqual(["a", "b"]);
    await t.publish([e]);
    await expect(t.consume("a", "c", async () => Promise.reject(new Error("x")))).rejects.toThrow();
    expect(await t.consume("a", "c", async () => undefined)).toBe(1);
  });
});

describe("RedisJobQueue", () => {
  it("delivers once per group, retries via the delayed set", async () => {
    const prefix = `cnote:test:${crypto.randomUUID()}`;
    const q = new RedisJobQueue(redis, prefix);
    await q.enqueue("test.echo", { n: 7 });
    const got: number[] = [];
    let first = true;
    const handler = async (m: { payload: { n: number } }) => {
      if (first) {
        first = false;
        throw new Error("transient");
      }
      got.push(m.payload.n);
    };
    await q.consume("test.echo", "g1", "c1", handler, { blockMs: 10 });
    expect(got).toEqual([]);
    // force the retry due now
    const keys = await redis.keys(`${prefix}:test.echo:delayed`);
    for (const k of keys) {
      const [m] = await redis.zrange(k, "0", "0");
      await redis.zadd(k, 0, m!);
    }
    expect(await q.promoteDelayed("test.echo")).toBe(1);
    await q.consume("test.echo", "g1", "c1", handler, { blockMs: 10 });
    expect(got).toEqual([7]);
    const all = await redis.keys(`${prefix}:*`);
    if (all.length) await redis.del(...all);
  });
});
