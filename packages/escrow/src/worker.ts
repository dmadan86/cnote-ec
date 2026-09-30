import { type ModuleWorker } from "@cnote/core";
import { expireUnfunded, onDisputeOpened, onDisputeResolved, onOrderStatusChanged, runAutoRelease } from "./escrow";
import { processPayouts } from "./payouts";
import { reconcile } from "./reconcile";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/**
 * Handlers are idempotent (at-least-once). Deliberately NOT gated on ESCROW_ENABLED: escrows that already exist keep
 * moving (milestones, freezes, payouts, releases) even if the flag is turned off for new ones.
 */
export const worker: ModuleWorker = {
  name: "escrow",
  handlers: {
    OrderStatusChanged: async (e) => onOrderStatusChanged(e.payload),
    DisputeOpened: async (e) => onDisputeOpened(e.payload),
    DisputeResolved: async (e) => onDisputeResolved(e.payload),
  },
  jobs: [
    { name: "escrow.process-payouts", everyMs: MIN_MS, run: async () => void (await processPayouts()) },
    { name: "escrow.auto-release", everyMs: 5 * MIN_MS, run: async () => void (await runAutoRelease()) },
    { name: "escrow.expire-unfunded", everyMs: 15 * MIN_MS, run: async () => void (await expireUnfunded()) },
    { name: "escrow.reconcile", everyMs: 6 * HOUR_MS, run: async () => void (await reconcile()) },
  ],
};
