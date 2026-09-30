import type { ModuleWorker } from "@cnote/core";
import { snapshotAllVerticals } from "./gates";

const DAY_MS = 86_400_000;

/** Daily snapshot of gate metrics for trend charts. Idempotent (one row per vertical per IST day). */
export const worker: ModuleWorker = {
  name: "verticals",
  handlers: {},
  jobs: [{ name: "verticals.snapshot-gates", everyMs: DAY_MS, run: async () => void (await snapshotAllVerticals()) }],
};
