import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisJobQueue, type QueueMessage } from "../src/queue";
import { redis } from "../src/redis";

declare module "../src/queue/types" {
  interface JobTopics {
    "rq.job": { n: number };
  }
}

const T = "rq.job" as const;
let prefix: string;
let q: RedisJobQueue;

beforeEach(() => {
  prefix = `cnote:test:${randomUUID()}`;
  q = new RedisJobQueue(redis, prefix);
});
afterEach(async () => {
  vi.useRealTimers();
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(...keys);
});

const consume = (queue: RedisJobQueue, h: (m: QueueMessage<{ n: number }>) => Promise<void>, group = "g", consumer = "c", count = 50) =>
  queue.consume(T, group, consumer, h, { blockMs: 5, count });
const ok = async () => undefined;
const boom = async () => {
  throw new Error("boom");
};

describe("RedisJobQueue: enqueue/consume", () => {
  it("delivers a message once with attempt=1 and the default maxAttempts=5", async () => {
    const id = await q.enqueue(T, { n: 1 });
    const seen: QueueMessage<{ n: number }>[] = [];
    expect(await consume(q, async (m) => void seen.push(m))).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, topic: T, payload: { n: 1 }, attempt: 1, maxAttempts: 5 });
    expect(Number.isNaN(Date.parse(seen[0]!.enqueuedAt))).toBe(false);
    expect(await consume(q, ok)).toBe(0); // acked: not redelivered
  });

  it("returns 0 on an empty topic and creates the group idempotently", async () => {
    expect(await consume(q, ok)).toBe(0);
    expect(await consume(q, ok)).toBe(0);
    // a second queue instance sharing the prefix hits BUSYGROUP and must swallow it
    expect(await consume(new RedisJobQueue(redis, prefix), ok)).toBe(0);
  });

  it("preserves FIFO order within a batch", async () => {
    for (let i = 0; i < 10; i++) await q.enqueue(T, { n: i });
    const got: number[] = [];
    await consume(q, async (m) => void got.push(m.payload.n));
    expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("respects the batch count", async () => {
    for (let i = 0; i < 5; i++) await q.enqueue(T, { n: i });
    expect(await consume(q, ok, "g", "c", 2)).toBe(2);
    expect(await consume(q, ok, "g", "c", 2)).toBe(2);
    expect(await consume(q, ok, "g", "c", 2)).toBe(1);
  });

  it("a JSON payload with unicode/nesting round-trips intact", async () => {
    const payload = { n: 1, deep: { s: "नमस्ते 🌏 \u0000 \"q\"", arr: [1, null, "x"] } } as never;
    await q.enqueue(T, payload);
    let got: unknown;
    await consume(q, async (m) => void (got = m.payload));
    expect(got).toEqual(payload);
  });

  it("two consumer groups each get every message (fan-out per group)", async () => {
    await q.enqueue(T, { n: 1 });
    const a: number[] = [];
    const b: number[] = [];
    await consume(q, async (m) => void a.push(m.payload.n), "ga");
    await consume(q, async (m) => void b.push(m.payload.n), "gb");
    expect([a, b]).toEqual([[1], [1]]);
  });

  it("competing consumers in one group handle every message exactly once", async () => {
    const N = 60;
    for (let i = 0; i < N; i++) await q.enqueue(T, { n: i });
    const seen: number[] = [];
    const worker = async (name: string) => {
      for (let round = 0; round < 8; round++) await consume(q, async (m) => void seen.push(m.payload.n), "g", name, 7);
    };
    await Promise.all([worker("c1"), worker("c2"), worker("c3")]);
    expect(seen.sort((x, y) => x - y)).toEqual(Array.from({ length: N }, (_, i) => i));
  });
});

describe("RedisJobQueue: dedupe", () => {
  it("drops duplicates with the same key per topic, allows different keys", async () => {
    expect(await q.enqueue(T, { n: 1 }, { dedupeKey: "k" })).toEqual(expect.any(String));
    expect(await q.enqueue(T, { n: 2 }, { dedupeKey: "k" })).toBeNull();
    expect(await q.enqueue(T, { n: 3 }, { dedupeKey: "other" })).toEqual(expect.any(String));
    expect(await q.enqueue(T, { n: 4 })).toEqual(expect.any(String)); // no key: never deduped
    expect(await q.enqueue(T, { n: 5 })).toEqual(expect.any(String));
    const got: number[] = [];
    await consume(q, async (m) => void got.push(m.payload.n));
    expect(got).toEqual([1, 3, 4, 5]);
  });

  it("concurrent producers with one key enqueue exactly once", async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, (_, i) => q.enqueue(T, { n: i }, { dedupeKey: "same" })));
    expect(ids.filter((x) => x !== null)).toHaveLength(1);
    expect(await consume(q, ok)).toBe(1);
  });

  it("dedupe marker expires after 24h", async () => {
    await q.enqueue(T, { n: 1 }, { dedupeKey: "ttl" });
    const ttl = await redis.ttl(`${prefix}:dedupe:${T}:ttl`);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });
});

describe("RedisJobQueue: retry, backoff, dead-letter, replay", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("a failed message is not redelivered until promoted; backoff follows retryDelayMs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await q.enqueue(T, { n: 1 });
    await consume(q, boom);
    const [[member, score]] = [(await redis.zrange(`${prefix}:${T}:delayed`, "0", "-1", "WITHSCORES")) as [string, string]];
    const delay = Number(score) - 1_000_000;
    expect(delay).toBeGreaterThanOrEqual(4000); // 5s +/- 20% jitter
    expect(delay).toBeLessThanOrEqual(6000);
    expect(JSON.parse(member)).toMatchObject({ attempt: 2, lastError: expect.stringContaining("boom") });

    expect(await q.promoteDelayed(T)).toBe(0); // not due yet
    vi.setSystemTime(1_000_000 + 3_999);
    expect(await q.promoteDelayed(T)).toBe(0);
    vi.setSystemTime(1_000_000 + 6_001);
    expect(await q.promoteDelayed(T)).toBe(1);
    expect(await q.promoteDelayed(T)).toBe(0); // moved, not duplicated

    const seen: number[] = [];
    await consume(q, async (m) => void seen.push(m.attempt));
    expect(seen).toEqual([2]);
  });

  it("dead-letters after maxAttempts with the exhausting attempt count and lastError", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    await q.enqueue(T, { n: 9 }, { maxAttempts: 3 });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("always");
    };
    for (let i = 0; i < 3; i++) {
      await consume(q, failing);
      vi.setSystemTime(Date.now() + 4 * 3_600_000);
      await q.promoteDelayed(T);
    }
    expect(calls).toBe(3);
    expect(await consume(q, failing)).toBe(0);
    const dead = await q.deadLetters(T);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ payload: { n: 9 }, attempt: 3, maxAttempts: 3, lastError: expect.stringContaining("always") });
    expect(await redis.zcard(`${prefix}:${T}:delayed`)).toBe(0);
  });

  it("maxAttempts=1 dead-letters on the first failure; lastError is truncated to 500 chars", async () => {
    await q.enqueue(T, { n: 1 }, { maxAttempts: 1 });
    await consume(q, async () => {
      throw new Error("x".repeat(5000));
    });
    const [m] = (await q.deadLetters(T)) as (QueueMessage & { lastError: string })[];
    expect(m!.attempt).toBe(1);
    expect(m!.lastError.length).toBeLessThanOrEqual(500);
  });

  it("a poison message does not block healthy ones in the same batch", async () => {
    await q.enqueue(T, { n: 1 }, { maxAttempts: 1 });
    await q.enqueue(T, { n: 2 });
    const done: number[] = [];
    await consume(q, async (m) => {
      if (m.payload.n === 1) throw new Error("poison");
      done.push(m.payload.n);
    });
    expect(done).toEqual([2]);
    expect(await q.deadLetters(T)).toHaveLength(1);
  });

  it("replayDeadLetter re-enqueues with attempt reset to 1, removes it from the DLQ, and is idempotent", async () => {
    await q.enqueue(T, { n: 5 }, { maxAttempts: 1 });
    await consume(q, boom);
    const [dead] = await q.deadLetters(T);
    expect(await q.replayDeadLetter(T, "nope")).toBe(false);
    expect(await q.replayDeadLetter(T, dead!.id)).toBe(true);
    expect(await q.replayDeadLetter(T, dead!.id)).toBe(false);
    expect(await q.deadLetters(T)).toHaveLength(0);
    const seen: QueueMessage<{ n: number }>[] = [];
    await consume(q, async (m) => void seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: dead!.id, attempt: 1, payload: { n: 5 } });
  });

  it("deadLetters honours the limit", async () => {
    for (let i = 0; i < 4; i++) await q.enqueue(T, { n: i }, { maxAttempts: 1 });
    await consume(q, boom);
    expect(await q.deadLetters(T, 2)).toHaveLength(2);
    expect(await q.deadLetters(T)).toHaveLength(4);
  });

  it("delayed enqueue is invisible until due, then delivered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(5_000);
    await q.enqueue(T, { n: 1 }, { delayMs: 10_000 });
    expect(await consume(q, ok)).toBe(0);
    expect(await q.promoteDelayed(T)).toBe(0);
    vi.setSystemTime(15_000);
    expect(await q.promoteDelayed(T)).toBe(1);
    expect(await consume(q, ok)).toBe(1);
  });

  it("delayMs <= 0 is treated as immediate", async () => {
    await q.enqueue(T, { n: 1 }, { delayMs: 0 });
    await q.enqueue(T, { n: 2 }, { delayMs: -5 });
    expect(await consume(q, ok)).toBe(2);
  });

  it("promoteDelayed moves at most 200 per call (bounded) and the rest on the next call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const pipe = redis.pipeline();
    for (let i = 0; i < 230; i++) pipe.zadd(`${prefix}:${T}:delayed`, 1, JSON.stringify({ id: String(i), topic: T, payload: { n: i }, attempt: 2, maxAttempts: 5, enqueuedAt: "" }));
    await pipe.exec();
    vi.setSystemTime(10);
    expect(await q.promoteDelayed(T)).toBe(200);
    expect(await q.promoteDelayed(T)).toBe(30);
    expect(await q.promoteDelayed(T)).toBe(0);
  });

  it("concurrent promoters never duplicate a message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    for (let i = 0; i < 30; i++) await q.enqueue(T, { n: i }, { delayMs: 1 });
    vi.setSystemTime(100);
    const moved = await Promise.all(Array.from({ length: 5 }, () => q.promoteDelayed(T)));
    expect(moved.reduce((a, b) => a + b, 0)).toBe(30);
    expect(await redis.xlen(`${prefix}:${T}`)).toBe(30);
  });

  it("a crashed consumer's pending (unacked) messages are redelivered to the same consumer name first", async () => {
    await q.enqueue(T, { n: 1 });
    await q.consume(T, "g", "c1", ok, { blockMs: 5 }); // create group at 0-position... message already handled; enqueue another
    await q.enqueue(T, { n: 2 });
    // simulate crash: read without ack
    await redis.xreadgroup("GROUP", "g", "c1", "COUNT", 10, "STREAMS", `${prefix}:${T}`, ">");
    const seen: number[] = [];
    await consume(q, async (m) => void seen.push(m.payload.n), "g", "c1");
    expect(seen).toEqual([2]);
    expect(await consume(q, ok, "g", "c1")).toBe(0);
  });
});

describe("RedisJobQueue: enqueue failure does not poison the dedupe key", () => {
  it("a failed add releases the marker so the producer's retry is enqueued (not dropped as a duplicate)", async () => {
    const xadd = vi.spyOn(redis, "xadd").mockRejectedValueOnce(new Error("redis down"));
    await expect(q.enqueue(T, { n: 1 }, { dedupeKey: "retry-me" })).rejects.toThrow("redis down");
    xadd.mockRestore();
    expect(await redis.exists(`${prefix}:dedupe:${T}:retry-me`)).toBe(0);
    expect(await q.enqueue(T, { n: 1 }, { dedupeKey: "retry-me" })).toEqual(expect.any(String));
    expect(await consume(q, ok)).toBe(1);
  });
  it("same for the delayed path; and a failed enqueue without a dedupe key just rethrows", async () => {
    const zadd = vi.spyOn(redis, "zadd").mockRejectedValueOnce(new Error("redis down"));
    await expect(q.enqueue(T, { n: 1 }, { dedupeKey: "d2", delayMs: 1000 })).rejects.toThrow("redis down");
    zadd.mockRestore();
    expect(await q.enqueue(T, { n: 1 }, { dedupeKey: "d2", delayMs: 1000 })).toEqual(expect.any(String));
    const xadd = vi.spyOn(redis, "xadd").mockRejectedValueOnce(new Error("boom"));
    await expect(q.enqueue(T, { n: 2 })).rejects.toThrow("boom");
    xadd.mockRestore();
  });
});

describe("RedisJobQueue: marker cleanup is best-effort", () => {
  it("if releasing the dedupe marker itself fails, the ORIGINAL enqueue error is still what the caller sees", async () => {
    vi.spyOn(redis, "xadd").mockRejectedValueOnce(new Error("original"));
    vi.spyOn(redis, "del").mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(q.enqueue(T, { n: 1 }, { dedupeKey: "k3" })).rejects.toThrow("original");
    vi.restoreAllMocks();
  });
});
