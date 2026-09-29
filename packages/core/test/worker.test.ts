import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateTags, redis, softInvalidateTags, cachedTagged } from "../src/redis";
import { queueConsumer } from "../src/worker";

describe("queueConsumer", () => {
  it("keeps topic/handler and leaves concurrency undefined unless given", async () => {
    const handler = vi.fn(async () => undefined);
    const c = queueConsumer("x.y" as never, handler as never);
    expect(c).toEqual({ topic: "x.y", handler, concurrency: undefined });
    expect(queueConsumer("x.y" as never, handler as never, 4).concurrency).toBe(4);
  });
});

describe("cache invalidation never throws (write paths must not fail because Redis is down)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("invalidateTags / softInvalidateTags swallow Redis errors and log", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(redis, "smembers").mockRejectedValue(new Error("down"));
    vi.spyOn(redis, "pipeline").mockImplementation(() => {
      throw new Error("down");
    });
    await expect(invalidateTags(["a"])).resolves.toBeUndefined();
    await expect(softInvalidateTags(["a"])).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
  });
  it("a Redis failure while checking invalidation timestamps still lets the load result through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = `test:cm:${crypto.randomUUID()}`;
    vi.spyOn(redis, "mget").mockRejectedValue(new Error("down"));
    expect(await cachedTagged(key, ["t-cm-x"], 30, async () => "v")).toBe("v");
    vi.restoreAllMocks();
    await redis.del(key);
  });
});
