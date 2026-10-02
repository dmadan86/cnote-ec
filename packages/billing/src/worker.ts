import type { ModuleWorker } from "@cnote/core";
import { expireLapsedCredits } from "./ledger";
import { endLapsedSubscriptions, grantDueAnnualCredits, sendRenewalReminders, startFreePlan } from "./subscriptions";

export const worker: ModuleWorker = {
  name: "billing",
  handlers: {
    BusinessCreated: async (e) => {
      await startFreePlan(e.payload.businessId);
    },
  },
  jobs: [
    { name: "billing.end-subscriptions", everyMs: 15 * 60_000, run: async () => void (await endLapsedSubscriptions()) },
    { name: "billing.annual-credits", everyMs: 60 * 60_000, run: async () => void (await grantDueAnnualCredits()) },
    { name: "billing.renewal-reminders", everyMs: 60 * 60_000, run: async () => void (await sendRenewalReminders()) },
    { name: "billing.expire-credits", everyMs: 60 * 60_000, run: async () => void (await expireLapsedCredits()) },
  ],
};
