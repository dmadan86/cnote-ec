import type { EventHandlers } from "./events/bus";

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
}
