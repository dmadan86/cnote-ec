import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createJobQueue, getJobQueue, MemoryJobQueue, RedisJobQueue, retryDelayMs, setJobQueue } from "../src/queue";

declare module "../src/queue/types" {
  interface JobTopics {
    "mq.job": { n: number };
  }
}
const T = "mq.job" as const;
const boom = async () => {
  throw new Error("x");
};

describe("retryDelayMs (properties)", () => {
  const opts = { seed: 1, numRuns: 300 };
  it("is monotonic non-decreasing in attempt for a fixed jitter", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 60 }), (r, a) => retryDelayMs(a + 1, () => r) >= retryDelayMs(a, () => r)),
      opts,
    );
  });
  it("never exceeds 1h * 1.2 and never goes below 80% of the base", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 1000 }), (r, a) => {
        const d = retryDelayMs(a, () => r);
        const base = Math.min(5000 * 5 ** (a - 1), 3_600_000);
        return d <= 3_600_000 * 1.2 && d >= Math.round(base * 0.8) && d <= Math.round(base * 1.2);
      }),
      opts,
    );
  });
  it("uses Math.random by default and stays in the jitter band", () => {
    for (let i = 0; i < 50; i++) {
      const d = retryDelayMs(1);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(6000);
    }
  });
  it("hits the documented schedule 5s, 25s, 125s, 625s, 3125s with neutral jitter, then caps at 1h", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5].map((a) => retryDelayMs(a, mid))).toEqual([5000, 25000, 125000, 625000, 3_125_000]);
    expect(retryDelayMs(6, mid)).toBe(3_600_000);
    expect(retryDelayMs(500, mid)).toBe(3_600_000);
  });
});

describe("MemoryJobQueue", () => {
  it("delivers in FIFO order, honours count, returns handled count", async () => {
    const q = new MemoryJobQueue();
    for (let i = 0; i < 5; i++) await q.enqueue(T, { n: i });
    const seen: number[] = [];
    expect(await q.consume(T, "g", "c", async (m) => void seen.push(m.payload.n), { count: 3 })).toBe(3);
    expect(await q.consume(T, "g", "c", async (m) => void seen.push(m.payload.n))).toBe(2);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(await q.consume(T, "g", "c", async () => undefined)).toBe(0);
  });

  it("delayed messages wait for the injected clock; promoteDelayed reports how many moved", async () => {
    let now = 1000;
    const q = new MemoryJobQueue(() => now);
    await q.enqueue(T, { n: 1 }, { delayMs: 500 });
    expect(await q.consume(T, "g", "c", async () => undefined)).toBe(0);
    now = 1499;
    expect(await q.promoteDelayed(T)).toBe(0);
    now = 1500;
    expect(await q.promoteDelayed(T)).toBe(1);
    expect(await q.promoteDelayed(T)).toBe(0);
    expect(await q.consume(T, "g", "c", async () => undefined)).toBe(1);
  });

  it("increments attempt on retry and dead-letters exactly at maxAttempts (default 5)", async () => {
    let now = 0;
    const q = new MemoryJobQueue(() => now);
    await q.enqueue(T, { n: 1 });
    const attempts: number[] = [];
    for (let i = 0; i < 8; i++) {
      await q.consume(T, "g", "c", async (m) => {
        attempts.push(m.attempt);
        throw new Error("x");
      });
      now += 4_000_000;
      await q.promoteDelayed(T);
    }
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(await q.deadLetters(T)).toHaveLength(1);
  });

  it("replay resets attempt and makes the message deliverable again; unknown id is false", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue(T, { n: 1 }, { maxAttempts: 1 });
    await q.consume(T, "g", "c", boom);
    const [d] = await q.deadLetters(T);
    expect(await q.replayDeadLetter(T, "ghost")).toBe(false);
    expect(await q.replayDeadLetter(T, d!.id)).toBe(true);
    expect(await q.deadLetters(T)).toEqual([]);
    const seen: number[] = [];
    await q.consume(T, "g", "c", async (m) => void seen.push(m.attempt));
    expect(seen).toEqual([1]);
  });

  it("dedupe is scoped per topic and per key", async () => {
    const q = new MemoryJobQueue();
    expect(await q.enqueue(T, { n: 1 }, { dedupeKey: "a" })).not.toBeNull();
    expect(await q.enqueue(T, { n: 1 }, { dedupeKey: "a" })).toBeNull();
    expect(await q.enqueue(T, { n: 1 }, { dedupeKey: "b" })).not.toBeNull();
    expect(await q.enqueue("mq.other" as never, { n: 1 } as never, { dedupeKey: "a" })).not.toBeNull();
  });

  it("deadLetters honours limit and topics are isolated", async () => {
    const q = new MemoryJobQueue();
    for (let i = 0; i < 3; i++) await q.enqueue(T, { n: i }, { maxAttempts: 1 });
    await q.consume(T, "g", "c", boom);
    expect(await q.deadLetters(T, 2)).toHaveLength(2);
    expect(await q.deadLetters("mq.empty")).toEqual([]);
    expect(await q.promoteDelayed("mq.empty")).toBe(0);
  });

  it("uses Date.now by default", async () => {
    const q = new MemoryJobQueue();
    const before = Date.now();
    await q.enqueue(T, { n: 1 });
    let at = 0;
    await q.consume(T, "g", "c", async (m) => void (at = Date.parse(m.enqueuedAt)));
    expect(at).toBeGreaterThanOrEqual(before);
  });
});

describe("queue factory", () => {
  afterEach(() => {
    setJobQueue(undefined);
    delete process.env.QUEUE_DRIVER;
  });
  it("builds the right driver", () => {
    expect(createJobQueue("memory")).toBeInstanceOf(MemoryJobQueue);
    expect(createJobQueue("redis")).toBeInstanceOf(RedisJobQueue);
    expect(createJobQueue("redis").driver).toBe("redis");
    expect(() => createJobQueue("kafka")).toThrow(/not implemented/);
  });
  it("getJobQueue is a memoised singleton driven by QUEUE_DRIVER; setJobQueue swaps it", () => {
    process.env.QUEUE_DRIVER = "memory";
    const a = getJobQueue();
    expect(a.driver).toBe("memory");
    expect(getJobQueue()).toBe(a);
    const b = new MemoryJobQueue();
    setJobQueue(b);
    expect(getJobQueue()).toBe(b);
    setJobQueue(undefined);
    expect(getJobQueue()).not.toBe(b);
  });
  it("defaults to redis when QUEUE_DRIVER is unset", () => {
    delete process.env.QUEUE_DRIVER;
    expect(getJobQueue().driver).toBe("redis");
  });
});
