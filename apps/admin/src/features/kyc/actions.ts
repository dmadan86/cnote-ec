"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { decideKyc, getKycReview, recordAuditResult, requestAudit, scheduleAudit } from "@cnote/identity";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";
import { ensureKycPorts } from "./ports";

const decision = z.object({ id: z.uuid(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().min(3, "A note is required.").max(500) });

/** Approve / reject a KYC session in review (audited under kyc.review). The note is kept on the session. */
export async function decideKycAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = decision.parse({ id: fd.get("id"), decision: fd.get("decision"), note: fd.get("note") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "kyc.review");
    const before = await getKycReview(input.id);
    const details: Record<string, unknown> = { decision: input.decision, note: input.note, businessId: before?.businessId ?? null, fromStatus: before?.status ?? null };
    await audited(ctx, "kyc.review", `kyc.${input.decision === "approved" ? "approve" : "reject"}`, { type: "kyc_session", id: input.id }, async () => {
      await decideKyc(input.id, input.decision, input.note, ctx.staff.id);
    }, details);
  });
  if (result.ok) { revalidatePath("/kyc"); revalidatePath(`/kyc/${String(fd.get("id"))}`); }
  return result;
}

const requestSchema = z.object({ businessId: z.uuid("Enter the business ID."), partner: z.string().trim().min(2).max(80) });
export async function requestAuditAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = requestSchema.parse({ businessId: String(fd.get("businessId") ?? "").trim(), partner: fd.get("partner") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    await audited(ctx, "audits.manage", "audit.request", { type: "business", id: input.businessId }, async () => {
      await requestAudit(input.businessId, input.partner, ctx.staff.id);
    }, { partner: input.partner });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}

const scheduleSchema = z.object({ id: z.uuid(), when: z.string().min(1, "Pick a date and time.") });
export async function scheduleAuditAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = scheduleSchema.parse({ id: fd.get("id"), when: fd.get("when") });
    const at = new Date(input.when);
    if (Number.isNaN(at.getTime())) throw new Error("Invalid date.");
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    await audited(ctx, "audits.manage", "audit.schedule", { type: "verification_audit", id: input.id }, async () => {
      await scheduleAudit(input.id, at, ctx.staff.id);
    }, { scheduledFor: at.toISOString() });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}

const REPORT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/zip", "application/pdf"];
const resultSchema = z.object({
  id: z.uuid(), result: z.enum(["pass", "fail", "conditional"]), summary: z.string().trim().min(3, "Add a short summary.").max(2000), validUntil: z.string().min(1, "Set the validity date."),
});
/** Record the partner's result; optional report (image/zip/pdf, up to ~1 MB via server actions). */
export async function recordAuditAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = resultSchema.parse({ id: fd.get("id"), result: fd.get("result"), summary: fd.get("summary"), validUntil: fd.get("validUntil") });
    const validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime())) throw new Error("Invalid date.");
    const file = fd.get("report");
    let report: { bytes: Uint8Array; mime: string } | null = null;
    if (file instanceof File && file.size > 0) {
      if (!REPORT_MIMES.includes(file.type)) throw new Error("Report must be an image, zip or PDF.");
      report = { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type };
    }
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    ensureKycPorts();
    await audited(ctx, "audits.manage", "audit.record_result", { type: "verification_audit", id: input.id }, async () => {
      await recordAuditResult(input.id, { result: input.result, findings: { summary: input.summary }, reportBytes: report?.bytes, reportMime: report?.mime, validUntil }, ctx.staff.id);
    }, { result: input.result, validUntil: validUntil.toISOString(), hasReport: !!report });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}
