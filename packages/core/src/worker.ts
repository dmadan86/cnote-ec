import type { EventHandlers } from "./events/bus";
import type { JobHandler, JobTopic, JobTopics } from "./queue/types";

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
}

/** What each domain module exports as `worker` for apps/worker to run. */
export interface ModuleWorker {
  /** Consumer-group name; one per module. */
  name: string;
  handlers: EventHandlers;
  jobs: ScheduledJob[];
  /** Work-queue consumers (JobQueue topics this module processes). */
  queues?: QueueConsumer[];
}

export interface QueueConsumer<K extends JobTopic = JobTopic> {
  topic: K;
  handler: JobHandler<JobTopics[K]>;
  /** parallel consumer loops for this topic in one worker process (default 1) */
  concurrency?: number;
}

/** Helper that keeps topic and handler payload types aligned. */
export function queueConsumer<K extends JobTopic>(topic: K, handler: JobHandler<JobTopics[K]>, concurrency?: number): QueueConsumer {
  return { topic, handler, concurrency } as unknown as QueueConsumer;
}
