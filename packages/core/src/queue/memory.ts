import { randomUUID } from "node:crypto";
import { retryDelayMs, type ConsumeOptions, type EnqueueOptions, type JobHandler, type JobQueue, type JobTopic, type JobTopics, type QueueMessage } from "./types";

/** In-process queue for tests and scripts. Same semantics as the Redis driver, no persistence. */
export class MemoryJobQueue implements JobQueue {
  readonly driver = "memory";
  private live = new Map<string, QueueMessage[]>();
  private delayed = new Map<string, { due: number; msg: QueueMessage }[]>();
  private dlq = new Map<string, QueueMessage[]>();
  private dedupe = new Set<string>();

  constructor(private now: () => number = Date.now) {}

  async enqueue<K extends JobTopic>(topic: K, payload: JobTopics[K], opts: EnqueueOptions = {}): Promise<string | null> {
    if (opts.dedupeKey) {
      const k = `${topic}:${opts.dedupeKey}`;
      if (this.dedupe.has(k)) return null;
      this.dedupe.add(k);
    }
    const msg: QueueMessage = { id: randomUUID(), topic, payload, attempt: 1, maxAttempts: opts.maxAttempts ?? 5, enqueuedAt: new Date(this.now()).toISOString() };
    if (opts.delayMs) this.list(this.delayed, topic).push({ due: this.now() + opts.delayMs, msg });
    else this.list(this.live, topic).push(msg);
    return msg.id;
  }

  async consume<K extends JobTopic>(topic: K, _group: string, _consumer: string, handler: JobHandler<JobTopics[K]>, opts: ConsumeOptions = {}): Promise<number> {
    const batch = this.list(this.live, topic).splice(0, opts.count ?? 50);
    for (const msg of batch) {
      try {
        await handler(msg as QueueMessage<JobTopics[K]>);
      } catch {
        if (msg.attempt >= msg.maxAttempts) this.list(this.dlq, topic).push(msg);
        else this.list(this.delayed, topic).push({ due: this.now() + retryDelayMs(msg.attempt), msg: { ...msg, attempt: msg.attempt + 1 } });
      }
    }
    return batch.length;
  }

  async promoteDelayed(topic: string): Promise<number> {
    const d = this.list(this.delayed, topic);
    const due = d.filter((x) => x.due <= this.now());
    this.delayed.set(topic, d.filter((x) => x.due > this.now()));
    this.list(this.live, topic).push(...due.map((x) => x.msg));
    return due.length;
  }

  async deadLetters(topic: string, limit = 50): Promise<QueueMessage[]> {
    return this.list(this.dlq, topic).slice(0, limit);
  }

  async replayDeadLetter(topic: string, id: string): Promise<boolean> {
    const d = this.list(this.dlq, topic);
    const i = d.findIndex((m) => m.id === id);
    if (i < 0) return false;
    const [msg] = d.splice(i, 1);
    this.list(this.live, topic).push({ ...msg!, attempt: 1 });
    return true;
  }

  private list<V>(m: Map<string, V[]>, k: string): V[] {
    let v = m.get(k);
    if (!v) m.set(k, (v = []));
    return v;
  }
}
