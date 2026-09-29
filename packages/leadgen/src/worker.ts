import type { ModuleWorker } from "@cnote/core";
import { sweepAbandoned } from "./abandon";

export const worker: ModuleWorker = {
  name: "leadgen",
  handlers: {},
  jobs: [{ name: "leadgen.sweep-abandoned", everyMs: 5 * 60_000, run: async () => void (await sweepAbandoned()) }],
};
