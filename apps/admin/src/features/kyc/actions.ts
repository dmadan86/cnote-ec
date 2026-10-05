"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import {
  assignAuditPartner, createAuditPartner, decideKyc, getKycReview, issueAuditUploadLink, recordAuditResult, requestAudit, requestAuditResubmission, reviewAuditSubmission, scheduleAudit, setAuditPartnerActive,
} from "@cnote/identity";
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

// ---- T3 partner-submission flow (docs/design/verification-t2-t3.md) ----
const partnerSchema = z.object({ name: z.string().trim().min(2).max(120), contactEmail: z.string().trim().max(160).optional() });
export async function createAuditPartnerAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = partnerSchema.parse({ name: fd.get("name"), contactEmail: String(fd.get("contactEmail") ?? "") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    await audited(ctx, "audits.manage", "audit.partner_create", { type: "audit_partner", id: "new" }, async () => { await createAuditPartner(input); }, { name: input.name });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}
export async function toggleAuditPartnerAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = z.object({ id: z.uuid(), active: z.enum(["true", "false"]) }).parse({ id: fd.get("id"), active: fd.get("active") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    await audited(ctx, "audits.manage", "audit.partner_toggle", { type: "audit_partner", id: input.id }, async () => { await setAuditPartnerActive(input.id, input.active === "true"); }, { active: input.active });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}
export async function assignAuditPartnerAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = z.object({ id: z.uuid(), partnerId: z.uuid("Choose a partner.") }).parse({ id: fd.get("id"), partnerId: fd.get("partnerId") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    await audited(ctx, "audits.manage", "audit.assign_partner", { type: "verification_audit", id: input.id }, async () => { await assignAuditPartner(input.id, input.partnerId); }, { partnerId: input.partnerId });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}

/** Issues the single-use partner link. The link is returned ONCE to the staff member (only its hash is stored) and never written to the audit log. */
export async function issueAuditLinkAction(_prev: ActionResult<{ url: string; expiresAt: string }> | null, fd: FormData): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  const result = await runAction(async () => {
    const id = z.uuid().parse(fd.get("id"));
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    let out!: { token: string; expiresAt: string };
    await audited(ctx, "audits.manage", "audit.issue_link", { type: "verification_audit", id }, async () => { out = await issueAuditUploadLink(id); }, {});
    const base = (process.env.AUDIT_PARTNER_BASE_URL ?? process.env.ADMIN_APP_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    return { url: `${base}/partner/audit/${out.token}`, expiresAt: out.expiresAt };
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}

const reviewSchema = z.object({ id: z.uuid(), result: z.enum(["pass", "fail", "conditional"]), note: z.string().trim().min(3, "Add a review note.").max(2000), validUntil: z.string().min(1, "Set the validity date.") });
export async function reviewAuditSubmissionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = reviewSchema.parse({ id: fd.get("id"), result: fd.get("result"), note: fd.get("note"), validUntil: fd.get("validUntil") });
    const validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime())) throw new Error("Invalid date.");
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    await audited(ctx, "audits.manage", "audit.review_submission", { type: "verification_audit", id: input.id }, async () => {
      await reviewAuditSubmission(input.id, { result: input.result, validUntil, note: input.note }, ctx.staff.id);
    }, { result: input.result, validUntil: validUntil.toISOString() });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}
export async function resubmitAuditAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = z.object({ id: z.uuid(), note: z.string().trim().min(3, "Tell the partner what to fix.").max(500) }).parse({ id: fd.get("id"), note: fd.get("note") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "audits.manage");
    ensureKycPorts();
    await audited(ctx, "audits.manage", "audit.send_back", { type: "verification_audit", id: input.id }, async () => { await requestAuditResubmission(input.id, input.note); }, { note: input.note });
  });
  if (result.ok) revalidatePath("/audits");
  return result;
}
