import type Redis from "ioredis";
import { retryDelayMs, type ConsumeOptions, type EnqueueOptions, type JobHandler, type JobQueue, type JobTopic, type JobTopics, type QueueMessage } from "./types";

type StreamRead = [string, [string, string[]][]][] | null;

// Atomically move due members of a ZSET into a stream.
const PROMOTE_LUA = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 200)
for _, m in ipairs(due) do
  redis.call('XADD', KEYS[2], '*', 'msg', m)
  redis.call('ZREM', KEYS[1], m)
end
return #due`;

/**
 * Redis Streams job queue. Per topic: stream `cnote:q:<topic>`, retry/delay ZSET `…:delayed`
 * (score = due time), dead-letter stream `…:dlq`. Consumer groups give one-of-N delivery.
 */
export class RedisJobQueue implements JobQueue {
  readonly driver = "redis";
  private groups = new Set<string>();

  constructor(private redis: Redis, private prefix = "cnote:q") {}

  private key(topic: string, suffix = "") {
    return `${this.prefix}:${topic}${suffix}`;
  }

  async enqueue<K extends JobTopic>(topic: K, payload: JobTopics[K], opts: EnqueueOptions = {}): Promise<string | null> {
    if (opts.dedupeKey) {
      const ok = await this.redis.set(`${this.prefix}:dedupe:${topic}:${opts.dedupeKey}`, "1", "EX", 86_400, "NX");
      if (ok === null) return null;
    }
    const msg: QueueMessage = {
      id: crypto.randomUUID(),
      topic,
      payload,
      attempt: 1,
      maxAttempts: opts.maxAttempts ?? 5,
      enqueuedAt: new Date().toISOString(),
    };
    const raw = JSON.stringify(msg);
    if (opts.delayMs && opts.delayMs > 0) await this.redis.zadd(this.key(topic, ":delayed"), Date.now() + opts.delayMs, raw);
    else await this.redis.xadd(this.key(topic), "*", "msg", raw);
    return msg.id;
  }

  async consume<K extends JobTopic>(topic: K, group: string, consumer: string, handler: JobHandler<JobTopics[K]>, opts: ConsumeOptions = {}): Promise<number> {
    const stream = this.key(topic);
    await this.ensureGroup(stream, group);
    // Own pending (crashed mid-handle) first, then new messages.
    let res = (await this.redis.xreadgroup("GROUP", group, consumer, "COUNT", opts.count ?? 20, "STREAMS", stream, "0")) as StreamRead;
    if (!res?.[0]?.[1]?.length) {
      res = (await this.redis.xreadgroup("GROUP", group, consumer, "COUNT", opts.count ?? 20, "BLOCK", opts.blockMs ?? 1000, "STREAMS", stream, ">")) as StreamRead;
    }
    const entries = res?.[0]?.[1] ?? [];
    for (const [entryId, fields] of entries) {
      const msg = JSON.parse(fields[1] ?? "{}") as QueueMessage<JobTopics[K]>;
      try {
        await handler(msg);
      } catch (err) {
        const next = { ...msg, attempt: msg.attempt + 1, lastError: String(err).slice(0, 500) };
        if (msg.attempt >= msg.maxAttempts) await this.redis.xadd(this.key(topic, ":dlq"), "*", "msg", JSON.stringify(next));
        else await this.redis.zadd(this.key(topic, ":delayed"), Date.now() + retryDelayMs(msg.attempt), JSON.stringify(next));
        console.error(`[queue] ${topic}/${group} attempt ${msg.attempt}/${msg.maxAttempts} failed`, err);
      }
      await this.redis.xack(stream, group, entryId);
    }
    return entries.length;
  }

  async promoteDelayed(topic: string): Promise<number> {
    return (await this.redis.eval(PROMOTE_LUA, 2, this.key(topic, ":delayed"), this.key(topic), String(Date.now()))) as number;
  }

  async deadLetters(topic: string, limit = 50): Promise<QueueMessage[]> {
    const rows = await this.redis.xrange(this.key(topic, ":dlq"), "-", "+", "COUNT", limit);
    return rows.map(([, f]) => JSON.parse(f[1] ?? "{}") as QueueMessage);
  }

  async replayDeadLetter(topic: string, id: string): Promise<boolean> {
    const dlq = this.key(topic, ":dlq");
    for (const [entryId, f] of await this.redis.xrange(dlq, "-", "+")) {
      const msg = JSON.parse(f[1] ?? "{}") as QueueMessage;
      if (msg.id !== id) continue;
      await this.redis.xadd(this.key(topic), "*", "msg", JSON.stringify({ ...msg, attempt: 1 }));
      await this.redis.xdel(dlq, entryId);
      return true;
    }
    return false;
  }

  private async ensureGroup(stream: string, group: string) {
    const k = `${stream}|${group}`;
    if (this.groups.has(k)) return;
    try {
      await this.redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    this.groups.add(k);
  }
}
