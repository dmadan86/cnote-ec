// Transport-agnostic messaging (factory pattern). Redis Streams today; Kafka later by setting
// QUEUE_DRIVER=kafka and implementing the driver — callers never import a driver directly.

/**
 * Typed job topics. Modules add their own via declaration merging:
 *   declare module "@cnote/core" { interface JobTopics { "email.send": EmailJob } }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JobTopics {}
export type JobTopic = keyof JobTopics & string;

export interface QueueMessage<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  /** 1-based delivery attempt */
  attempt: number;
  maxAttempts: number;
  enqueuedAt: string;
}

export interface EnqueueOptions {
  /** run no earlier than now + delayMs */
  delayMs?: number;
  /** drop duplicates with the same key for 24h (idempotent producers) */
  dedupeKey?: string;
  /** default 5; after that the message goes to the topic's dead-letter queue */
  maxAttempts?: number;
}

export type JobHandler<T = unknown> = (msg: QueueMessage<T>) => Promise<void>;

export interface ConsumeOptions {
  count?: number;
  blockMs?: number;
}

/** Work queue: each message is handled by exactly one consumer in a group (at-least-once). */
export interface JobQueue {
  readonly driver: string;
  /** Returns the message id, or null when dropped by dedupeKey. */
  enqueue<K extends JobTopic>(topic: K, payload: JobTopics[K], opts?: EnqueueOptions): Promise<string | null>;
  /**
   * Process one batch for `group` (one group per consuming module). Failed messages are retried
   * with exponential backoff, then dead-lettered. Returns the number of messages handled.
   */
  consume<K extends JobTopic>(topic: K, group: string, consumer: string, handler: JobHandler<JobTopics[K]>, opts?: ConsumeOptions): Promise<number>;
  /** Move due delayed/retry messages onto the live queue. Called by the worker loop. */
  promoteDelayed(topic: string): Promise<number>;
  deadLetters(topic: string, limit?: number): Promise<QueueMessage[]>;
  /** Re-enqueue a dead-lettered message (ops). */
  replayDeadLetter(topic: string, id: string): Promise<boolean>;
}

/** Backoff for retry `attempt` (1-based): 5s, 25s, 2m, 10m, 50m … capped at 1h, with jitter. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5_000 * 5 ** (attempt - 1), 3_600_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}
