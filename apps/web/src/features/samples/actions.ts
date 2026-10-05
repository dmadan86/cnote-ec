"use server";
// Buyer-side sample actions. One action, several intents. Each re-checks the session: server actions are reachable by direct POST.
// Text-only: a server action's body is capped at 2 MB app-wide, so an evaluation WITH photos goes to POST /api/samples (see forms.tsx).
import { requireBusiness, type ActionResult } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { redirect } from "next/navigation";
import { runSampleIntent, sampleReturnTo } from "./run";

export async function sampleAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(sampleReturnTo(f));
  let created: string | null = null;
  const r = await runLocalized(async () => {
    created = (await runSampleIntent(f, s)).created;
  });
  if (r.ok && created) redirect(`/buyer/samples/${created}`);
  return r;
}
