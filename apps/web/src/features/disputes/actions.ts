"use server";
// Buyer-side dispute actions (ADR-013). One action, several intents. Each re-checks the session: server actions are reachable by direct POST.
// Text-only: a server action's body is capped at 2 MB app-wide, so submissions WITH evidence files go to POST /api/disputes (see forms.tsx).
import { requireBusiness, type ActionResult } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { redirect } from "next/navigation";
import { disputeReturnTo, runDisputeIntent } from "./run";

export async function disputeAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(disputeReturnTo(f));
  let created: string | null = null;
  const r = await runLocalized(async () => {
    created = (await runDisputeIntent(f, s)).created;
  });
  if (r.ok && created) redirect(`/buyer/disputes/${created}`);
  return r;
}
