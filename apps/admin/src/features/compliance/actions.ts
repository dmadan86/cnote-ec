"use server";
import { audited } from "@cnote/admin";
import { decideAppeal, respondToGrievance, RETENTION_POLICIES, runRetention } from "@cnote/compliance";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const respondSchema = z.object({
  id: z.uuid(),
  status: z.enum(["in_progress", "resolved", "rejected"]),
  resolution: z.string().trim().max(5000).optional(),
});

/** Grievance Officer response. Acknowledge (in_progress) or close (resolved/rejected, resolution required). */
export async function respondGrievanceAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const i = respondSchema.parse({ id: fd.get("id"), status: fd.get("status"), resolution: fd.get("resolution") || undefined });
    const ctx = await actionContext();
    await audited(ctx, "compliance.manage", "grievance.respond", { type: "GrievanceTicket", id: i.id }, () => respondToGrievance(i.id, { status: i.status, resolution: i.resolution }, ctx.staff.id), { status: i.status });
  });
  if (r.ok) revalidatePath("/compliance");
  return r;
}

const decideSchema = z.object({ id: z.uuid(), decision: z.enum(["resolved", "rejected"]), note: z.string().trim().max(500) });

/** Appeal decision. "resolved" (upheld) re-approves via the owning module where safe (see @cnote/compliance appeals). */
export async function decideAppealAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const i = decideSchema.parse({ id: fd.get("id"), decision: fd.get("decision"), note: fd.get("note") ?? "" });
    const ctx = await actionContext();
    await audited(ctx, "compliance.manage", "appeal.decide", { type: "ModerationAppeal", id: i.id }, () => decideAppeal(i.id, i.decision, i.note, ctx.staff.id), { decision: i.decision });
  });
  if (r.ok) {
    revalidatePath("/compliance/appeals");
    revalidatePath(`/compliance/appeals/${String(fd.get("id"))}`);
  }
  return r;
}

/** Manual retention DRY RUN (never deletes). Optionally limited to one policy. Audited; results land in the run log. */
export async function retentionDryRunAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const name = z.string().max(200).optional().parse(fd.get("policy") || undefined);
    const policies = name ? RETENTION_POLICIES.filter((p) => p.name === name) : RETENTION_POLICIES;
    const ctx = await actionContext();
    await audited(ctx, "compliance.manage", "retention.dry_run", { type: "RetentionPolicy", id: name ?? "all" }, () => runRetention({ policies, dryRun: true }), { policy: name ?? "all" });
  });
  if (r.ok) revalidatePath("/compliance/retention");
  return r;
}
