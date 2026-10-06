// T3: physical / third-party audit by a partner agency (ADR-003). Staff-driven (callers wrap each mutation in
// admin.audited("audits.manage")). pass -> tier 3 + VerificationRecord(audit) + AuditCompleted; the tier lapses back to 2
// when validUntil passes (expireAudits, run daily) and trust is recomputed (continuous trust, ADR-003).
import { randomUUID } from "node:crypto";
import { DomainError, emit, type ScheduledJob } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { bustSellerCaches } from "./business";
import { kycPorts } from "./kyc";

export type AuditStatus = "requested" | "scheduled" | "submitted" | "completed" | "failed" | "cancelled" | "expired";
export type AuditResult = "pass" | "fail" | "conditional";
export interface AuditView {
  id: string; businessId: string; businessName: string | null; partner: string; status: AuditStatus; scheduledFor: string | null;
  result: AuditResult | null; findings: unknown; validUntil: string | null; hasReport: boolean; requestedBy: string | null; createdAt: string;
  partnerId: string | null; submittedAt: string | null; reAuditDueAt: string | null; reviewNote: string | null;
  /** partner submission summary (counts + flags), never the photos' coordinates */
  submission: { photoCount: number; flags: string[]; checklistPassed: boolean; inspector: string | null } | null;
}
/** "submitted" = the partner uploaded the checklist and photos; staff review then records the result. */
export const OPEN = ["requested", "scheduled", "submitted"];
/** The T3 badge asks for a re-audit this many days before it lapses. */
export const REAUDIT_LEAD_DAYS = 30;

const REPORT_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/zip": "zip", "application/pdf": "pdf" };
export const auditReportKey = (businessId: string, auditId: string, ext: string) => `kyc/audit/${businessId}/${auditId}.${ext}`;

type Row = Prisma.VerificationAuditGetPayload<object> & { business?: { name: string } | null };
const view = (a: Row): AuditView => ({
  id: a.id, businessId: a.businessId, businessName: a.business?.name ?? null, partner: a.partner, status: a.status as AuditStatus,
  scheduledFor: a.scheduledFor?.toISOString() ?? null, result: (a.result as AuditResult | null) ?? null, findings: a.findings,
  validUntil: a.validUntil?.toISOString() ?? null, hasReport: !!a.reportKey, requestedBy: a.requestedBy, createdAt: a.createdAt.toISOString(),
  partnerId: a.partnerId, submittedAt: a.submittedAt?.toISOString() ?? null, reAuditDueAt: a.reAuditDueAt?.toISOString() ?? null, reviewNote: a.reviewNote,
  submission: summarise(a.submission),
});
function summarise(raw: unknown): AuditView["submission"] {
  const x = raw as { photos?: unknown[]; flags?: string[]; checklistPassed?: boolean; inspector?: string } | null;
  return x ? { photoCount: x.photos?.length ?? 0, flags: x.flags ?? [], checklistPassed: x.checklistPassed === true, inspector: x.inspector ?? null } : null;
}

export async function load(auditId: string) {
  const a = await prisma.verificationAudit.findUnique({ where: { id: auditId } });
  if (!a) throw new DomainError("not_found", "Audit not found.", undefined, "account.auditNotFound");
  return a;
}

/** Requests a partner audit. The business must be KYC verified (T2) and have no open audit. */
export async function requestAudit(businessId: string, partner: string, staffId: string): Promise<AuditView> {
  if (!partner.trim()) throw new DomainError("validation", "Choose an audit partner.", undefined, "account.chooseAuditPartner");
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { verificationTier: true } });
  if (!b) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
  if (b.verificationTier < 2) throw new DomainError("validation", "The business must complete KYC (Tier 2) before a physical audit.", undefined, "account.businessMustCompleteKycTier");
  if (await prisma.verificationAudit.findFirst({ where: { businessId, status: { in: OPEN } }, select: { id: true } })) throw new DomainError("conflict", "This business already has an open audit.", undefined, "account.businessAlreadyOpenAudit");
  return view(await prisma.verificationAudit.create({ data: { businessId, partner: partner.trim(), requestedBy: staffId } }));
}

export async function scheduleAudit(auditId: string, scheduledFor: Date, staffId: string, now = new Date()): Promise<AuditView> {
  if (scheduledFor <= now) throw new DomainError("validation", "Schedule the audit in the future.", undefined, "account.scheduleAuditFuture");
  const a = await load(auditId);
  if (a.status !== "requested" && a.status !== "scheduled") throw new DomainError("conflict", "Only requested or scheduled audits can be scheduled.", undefined, "account.onlyRequestedScheduledAuditsScheduled");
  const u = await prisma.verificationAudit.update({ where: { id: auditId }, data: { status: "scheduled", scheduledFor, requestedBy: a.requestedBy ?? staffId } });
  return view(u);
}

export async function cancelAudit(auditId: string): Promise<AuditView> {
  const a = await load(auditId);
  if (!OPEN.includes(a.status)) throw new DomainError("conflict", "Only open audits can be cancelled.", undefined, "account.onlyOpenAuditsCancelled");
  return view(await prisma.verificationAudit.update({ where: { id: auditId }, data: { status: "cancelled" } }));
}

export interface AuditResultInput {
  result: AuditResult;
  findings: Record<string, unknown>;
  reportBytes?: Uint8Array;
  /** image/jpeg | image/png | image/webp | application/zip (| application/pdf once the media store allows it) */
  reportMime?: string;
  validUntil: Date;
  /** staff note shown on the audit (partner-submission review) */
  reviewNote?: string;
}

export async function recordAuditResult(auditId: string, input: AuditResultInput, staffId: string, now = new Date()): Promise<AuditView> {
  const a = await load(auditId);
  if (!OPEN.includes(a.status)) throw new DomainError("conflict", "This audit already has a result.", undefined, "account.auditAlreadyResult");
  if (input.result === "pass" && input.validUntil <= now) throw new DomainError("validation", "validUntil must be in the future for a passing audit.", undefined, "account.validuntilMustFuturePassingAudit");
  let reportKey: string | null = null;
  if (input.reportBytes?.length) {
    const ext = REPORT_EXT[input.reportMime ?? ""];
    if (!ext) throw new DomainError("validation", "Report must be an image or a zip archive.", undefined, "account.reportMustImageZipArchive");
    reportKey = auditReportKey(a.businessId, `${a.id}-${randomUUID().slice(0, 8)}`, ext);
    await kycPorts().store.put(reportKey, input.reportBytes, input.reportMime!);
  }
  const details = { auditId, partner: a.partner, result: input.result, findings: input.findings, validUntil: input.validUntil.toISOString(), staffId } as Prisma.InputJsonValue;
  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.verificationAudit.updateMany({ where: { id: auditId, status: { in: OPEN } }, data: { status: input.result === "fail" ? "failed" : "completed" } });
    /* v8 ignore next */
    if (claimed.count === 0) throw new DomainError("conflict", "This audit already has a result.", undefined, "account.auditAlreadyResult");
    const u = await tx.verificationAudit.update({ where: { id: auditId }, data: {
      result: input.result, findings: input.findings as Prisma.InputJsonValue, validUntil: input.validUntil, reportKey, reviewedBy: staffId, reviewNote: input.reviewNote?.trim() || null,
      reAuditDueAt: input.result === "pass" ? new Date(input.validUntil.getTime() - REAUDIT_LEAD_DAYS * 86_400_000) : null, uploadTokenHash: null, uploadTokenExpiresAt: null,
    } });
    await tx.verificationRecord.create({ data: { businessId: a.businessId, tier: 3, kind: "audit", status: input.result === "pass" ? "passed" : input.result === "fail" ? "failed" : "pending", provider: a.partner, details } });
    if (input.result === "pass") {
      const cur = await tx.business.findUniqueOrThrow({ where: { id: a.businessId }, select: { verificationTier: true } });
      const tier = Math.max(cur.verificationTier, 3);
      await tx.business.update({ where: { id: a.businessId }, data: { verificationTier: tier } });
      await emit(tx, "BusinessVerified", { type: "Business", id: a.businessId }, { businessId: a.businessId, tier, kind: "audit" });
    }
    await emit(tx, "AuditCompleted", { type: "Audit", id: auditId }, { auditId, businessId: a.businessId, result: input.result, validUntil: input.validUntil.toISOString() });
    return u;
  });
  if (input.result === "pass") await afterTierChange(a.businessId);
  return view(row);
}

async function afterTierChange(businessId: string): Promise<void> {
  const { recomputeTrust } = await import("./trust-worker"); // lazy: trust-worker imports this module's jobs
  await recomputeTrust(businessId);
  await bustSellerCaches(businessId);
}

/** Staff-only report read. */
export async function readAuditReport(auditId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const a = await load(auditId);
  return a.reportKey ? kycPorts().store.get(a.reportKey) : null;
}

export async function listAudits(opts: { businessId?: string; status?: AuditStatus; limit?: number } = {}): Promise<AuditView[]> {
  const rows = await prisma.verificationAudit.findMany({
    where: { ...(opts.businessId ? { businessId: opts.businessId } : {}), ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" }, take: Math.min(Math.max(opts.limit ?? 100, 1), 200),
  });
  const names = new Map((await prisma.business.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.businessId))] } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  return rows.map((r) => view({ ...r, business: names.has(r.businessId) ? { name: names.get(r.businessId)! } : null }));
}

/** Passing audits whose validUntil has passed: tier 3 lapses to 2, trust recomputed. Returns how many lapsed. */
export async function expireAudits(now = new Date()): Promise<number> {
  const due = await prisma.verificationAudit.findMany({ where: { status: "completed", result: "pass", validUntil: { lt: now } }, take: 500 });
  let n = 0;
  for (const a of due) {
    const lapsed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.verificationAudit.updateMany({ where: { id: a.id, status: "completed" }, data: { status: "expired" } });
      /* v8 ignore next */
      if (claimed.count === 0) return false;
      // another still-valid passing audit keeps tier 3
      const other = await tx.verificationAudit.findFirst({ where: { businessId: a.businessId, status: "completed", result: "pass", validUntil: { gte: now } }, select: { id: true } });
      const cur = await tx.business.findUniqueOrThrow({ where: { id: a.businessId }, select: { verificationTier: true } });
      if (!other && cur.verificationTier >= 3) {
        await tx.business.update({ where: { id: a.businessId }, data: { verificationTier: 2 } });
        await tx.verificationRecord.create({ data: { businessId: a.businessId, tier: 3, kind: "audit", status: "failed", provider: a.partner, details: { auditId: a.id, expired: true, validUntil: a.validUntil!.toISOString() } } });
        await emit(tx, "BusinessVerified", { type: "Business", id: a.businessId }, { businessId: a.businessId, tier: 2, kind: "audit_expired" });
      }
      return true;
    });
    if (lapsed) { n++; await afterTierChange(a.businessId); }
  }
  return n;
}

/** Wire into the identity worker's `jobs` (see trust-worker.ts). */
export const auditWorkerJobs: ScheduledJob[] = [
  { name: "identity.audit-expiry", everyMs: 86_400_000, run: async () => void (await expireAudits()) },
];
