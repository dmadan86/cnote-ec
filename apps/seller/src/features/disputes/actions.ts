"use server";
// Seller-side dispute actions (ADR-013): respond, add evidence, message staff, escalate an auto-decision, appeal, withdraw.
// Text-only: a server action's body is capped at 2 MB app-wide, so submissions WITH evidence files go to POST /api/disputes (see forms.tsx).
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";
import { disputeIdOf, runDisputeIntent } from "./run";

export type DisputeResult = ActionResult<null>;

export async function disputeAction(_prev: DisputeResult | null, fd: FormData): Promise<DisputeResult> {
  const session = await requireSeller(`/disputes/${disputeIdOf(fd)}`);
  return run(() => runDisputeIntent(fd, session));
}
