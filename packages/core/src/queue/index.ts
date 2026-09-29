import { redis } from "../redis";
import { createKafkaJobQueue } from "./kafka";
import { MemoryJobQueue } from "./memory";
import { RedisJobQueue } from "./redis";
import type { JobQueue } from "./types";

export * from "./types";
export { MemoryJobQueue } from "./memory";
export { RedisJobQueue } from "./redis";

export type QueueDriver = "redis" | "kafka" | "memory";

/** Factory: build a queue for a driver. */
export function createJobQueue(driver: QueueDriver): JobQueue {
  switch (driver) {
    case "redis":
      return new RedisJobQueue(redis);
    case "memory":
      return new MemoryJobQueue();
    case "kafka":
      return createKafkaJobQueue();
  }
}

let instance: JobQueue | undefined;

/** Process-wide queue selected by QUEUE_DRIVER (default redis). */
export function getJobQueue(): JobQueue {
  return (instance ??= createJobQueue((process.env.QUEUE_DRIVER as QueueDriver | undefined) ?? "redis"));
}

/** Tests: swap in a MemoryJobQueue (or reset with undefined). */
export function setJobQueue(q: JobQueue | undefined) {
  instance = q;
}
