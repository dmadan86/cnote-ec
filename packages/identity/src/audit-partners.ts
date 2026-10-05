// T3 partner-submission flow (ADR-003): staff assign a physical audit to an external partner agency, issue a single-use
// signed upload link, the partner submits a checklist + geotagged photos from the site, staff review (audited by the caller)
// and the result lifts the business to tier 3 until validUntil, with a re-audit date (audits.ts recordAuditResult).
//
// The partner is NOT a login: it is an `AuditPartner` record plus a link token (32 random bytes, only the sha256 stored,
// 14 days, single use). Photos live in the PRIVATE store; coordinates are kept in the submission (premises location is
// business data) and purged with the photos (purgeAuditPhotos, compliance retention). See docs/design/verification-t2-t3.md.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError, emit } from "@cnote/core";
import { Prisma, prisma } from "@cnote/db";
import { OPEN, load, recordAuditResult, type AuditResult, type AuditView } from "./audits";
import { kycPorts } from "./kyc";

export const AUDIT_LINK_TTL_DAYS = 14;
export const MIN_AUDIT_PHOTOS = 4;
export const MAX_AUDIT_PHOTOS = 12;
export const MAX_AUDIT_PHOTO_BYTES = 6 * 1024 * 1024;
/** photos must be taken on one site: every photo within this many metres of the group centroid */
export const MAX_SITE_RADIUS_M = 300;
/** a geotag older than this (or in the future) is not evidence of a visit "now" */
export const MAX_PHOTO_AGE_MS = 72 * 3_600_000;
export const AUDIT_PHOTO_PREFIX = "kyc/audit/";

export interface ChecklistItem { id: string; label: string; required: boolean }
/** Default site-audit checklist. A category that needs more overrides it with AUDIT_CHECKLIST_JSON (config, not code, ADR-011). */
export const DEFAULT_AUDIT_CHECKLIST: ChecklistItem[] = [
  { id: "premises_exist", label: "Premises exist at the registered address and the business name board is visible", required: true },
  { id: "owner_present", label: "Owner or authorised signatory met in person", required: true },
  { id: "operations_visible", label: "Production or trading activity visible", required: true },
  { id: "stock_matches", label: "Stock or machinery matches the listed products", required: false },
  { id: "documents_sighted", label: "Original GST certificate and licences sighted", required: true },
  { id: "capacity_plausible", label: "Stated capacity is plausible for the premises", required: false },
];
export function auditChecklist(env: Record<string, string | undefined> = process.env): ChecklistItem[] {
  const raw = env.AUDIT_CHECKLIST_JSON?.trim();
  if (!raw) return DEFAULT_AUDIT_CHECKLIST;
  try {
    const parsed = JSON.parse(raw) as ChecklistItem[];
    const ok = Array.isArray(parsed) && parsed.length > 0 && parsed.every((i) => typeof i.id === "string" && /^[a-z0-9_]{1,40}$/.test(i.id) && typeof i.label === "string" && i.label.length <= 200);
    return ok ? parsed.map((i) => ({ id: i.id, label: i.label, required: i.required !== false })) : DEFAULT_AUDIT_CHECKLIST;
  } catch { return DEFAULT_AUDIT_CHECKLIST; }
}

// ---------------- partners ----------------
export interface AuditPartnerView { id: string; name: string; contactEmail: string | null; active: boolean; createdAt: string }
const pview = (p: Prisma.AuditPartnerGetPayload<object>): AuditPartnerView => ({ id: p.id, name: p.name, contactEmail: p.contactEmail, active: p.active, createdAt: p.createdAt.toISOString() });

/** Staff (wrap in audited "audits.manage"). */
export async function createAuditPartner(input: { name: string; contactEmail?: string }): Promise<AuditPartnerView> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new DomainError("validation", "Enter the partner name.");
  const email = input.contactEmail?.trim() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DomainError("validation", "Enter a valid contact email.");
  return pview(await prisma.auditPartner.create({ data: { name, contactEmail: email } }));
}
export async function setAuditPartnerActive(id: string, active: boolean): Promise<AuditPartnerView> {
  const p = await prisma.auditPartner.findUnique({ where: { id } });
  if (!p) throw new DomainError("not_found", "Partner not found.");
  return pview(await prisma.auditPartner.update({ where: { id }, data: { active } }));
}
export async function listAuditPartners(opts: { activeOnly?: boolean } = {}): Promise<AuditPartnerView[]> {
  return (await prisma.auditPartner.findMany({ where: opts.activeOnly ? { active: true } : {}, orderBy: { name: "asc" }, take: 200 })).map(pview);
}

/** Assigns an open audit to a partner (replaces any earlier partner and revokes an unused link). */
export async function assignAuditPartner(auditId: string, partnerId: string): Promise<AuditView> {
  const [a, p] = await Promise.all([load(auditId), prisma.auditPartner.findUnique({ where: { id: partnerId } })]);
  if (!p || !p.active) throw new DomainError("validation", "Choose an active audit partner.");
  if (a.status !== "requested" && a.status !== "scheduled") throw new DomainError("conflict", "Only requested or scheduled audits can be assigned.");
  const { listAudits } = await import("./audits");
  await prisma.verificationAudit.update({ where: { id: auditId }, data: { partnerId, partner: p.name, uploadTokenHash: null, uploadTokenExpiresAt: null } });
  return (await listAudits({ businessId: a.businessId })).find((x) => x.id === auditId)!;
}

// ---------------- signed link ----------------
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

/** Issues (replaces) the single-use upload link. The raw token is returned once and never stored. */
export async function issueAuditUploadLink(auditId: string, now = new Date()): Promise<{ token: string; expiresAt: string }> {
  const a = await load(auditId);
  if (!a.partnerId) throw new DomainError("validation", "Assign an audit partner first.");
  if (a.status !== "requested" && a.status !== "scheduled") throw new DomainError("conflict", "Links can only be issued for requested or scheduled audits.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + AUDIT_LINK_TTL_DAYS * 86_400_000);
  await prisma.verificationAudit.update({ where: { id: auditId }, data: { uploadTokenHash: hashToken(token), uploadTokenExpiresAt: expiresAt } });
  return { token, expiresAt: expiresAt.toISOString() };
}

async function byToken(token: string, now: Date) {
  if (!TOKEN_RE.test(token)) throw new DomainError("not_found", "This audit link is not valid.");
  const a = await prisma.verificationAudit.findUnique({ where: { uploadTokenHash: hashToken(token) } });
  if (!a || !a.uploadTokenExpiresAt || a.uploadTokenExpiresAt <= now || (a.status !== "requested" && a.status !== "scheduled")) throw new DomainError("not_found", "This audit link is not valid or has expired.");
  return a;
}

export interface PartnerAuditBrief {
  auditId: string; partner: string; businessName: string; address: string | null; scheduledFor: string | null; expiresAt: string;
  checklist: ChecklistItem[]; minPhotos: number; maxPhotos: number;
}
/** What the partner sees: enough to find the site, nothing about the business's trust, KYC or contacts. */
export async function getAuditBriefForPartner(token: string, now = new Date()): Promise<PartnerAuditBrief> {
  const a = await byToken(token, now);
  const b = await prisma.business.findUnique({ where: { id: a.businessId }, select: { name: true, legalName: true, registeredAddress: true, city: true, state: true, pincode: true } });
  const r = b?.registeredAddress as { line1?: string; line2?: string; city?: string; state?: string; pincode?: string } | null;
  const address = r ? [r.line1, r.line2, r.city, r.state, r.pincode].filter(Boolean).join(", ") : [b?.city, b?.state, b?.pincode].filter(Boolean).join(", ") || null;
  return { auditId: a.id, partner: a.partner, businessName: b?.legalName ?? b?.name ?? "Business", address, scheduledFor: a.scheduledFor?.toISOString() ?? null, expiresAt: a.uploadTokenExpiresAt!.toISOString(), checklist: auditChecklist(), minPhotos: MIN_AUDIT_PHOTOS, maxPhotos: MAX_AUDIT_PHOTOS };
}

// ---------------- evaluation (pure) ----------------
export interface SubmittedPhoto { sha256: string; lat: number | null; lng: number | null; capturedAt: string | null }
export interface SubmissionEvaluation { flags: string[]; checklistPassed: boolean; siteRadiusM: number | null }

/** Inside India's bounding box (cheap plausibility; not a geofence of the premises). */
export const inIndia = (lat: number, lng: number) => lat >= 6 && lat <= 37.6 && lng >= 68 && lng <= 97.5;

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function evaluateAuditSubmission(i: {
  checklist: ChecklistItem[]; answers: Record<string, { ok: boolean; note?: string }>; photos: SubmittedPhoto[]; now: Date;
}): SubmissionEvaluation {
  const flags: string[] = [];
  let checklistPassed = true;
  for (const item of i.checklist) {
    const ans = i.answers[item.id];
    if (!ans) { if (item.required) { flags.push(`Checklist item not answered: ${item.label}`); checklistPassed = false; } continue; }
    if (!ans.ok) { flags.push(`Checklist item failed: ${item.label}${ans.note ? ` (${ans.note.slice(0, 120)})` : ""}`); if (item.required) checklistPassed = false; }
  }
  if (i.photos.length < MIN_AUDIT_PHOTOS) flags.push(`Only ${i.photos.length} photos; at least ${MIN_AUDIT_PHOTOS} are required.`);
  if (new Set(i.photos.map((p) => p.sha256)).size < i.photos.length) flags.push("The same photo was uploaded more than once.");
  const tagged = i.photos.filter((p): p is SubmittedPhoto & { lat: number; lng: number } => p.lat !== null && p.lng !== null);
  if (tagged.length < i.photos.length) flags.push(`${i.photos.length - tagged.length} photo(s) have no location.`);
  if (tagged.some((p) => !inIndia(p.lat, p.lng))) flags.push("A photo location is outside India.");
  let siteRadiusM: number | null = null;
  if (tagged.length >= 2) {
    const c = { lat: tagged.reduce((s, p) => s + p.lat, 0) / tagged.length, lng: tagged.reduce((s, p) => s + p.lng, 0) / tagged.length };
    siteRadiusM = Math.round(Math.max(...tagged.map((p) => haversineM(c, p))));
    if (siteRadiusM > MAX_SITE_RADIUS_M) flags.push(`Photos were taken ${siteRadiusM} m apart; expected one site (within ${MAX_SITE_RADIUS_M} m).`);
  }
  for (const p of i.photos) {
    if (!p.capturedAt) { flags.push("A photo has no capture time."); break; }
    const t = Date.parse(p.capturedAt);
    if (!Number.isFinite(t) || t > i.now.getTime() + 5 * 60_000 || i.now.getTime() - t > MAX_PHOTO_AGE_MS) { flags.push("A photo capture time is in the future or older than 72 hours."); break; }
  }
  return { flags, checklistPassed: checklistPassed && flags.every((f) => !f.startsWith("Only ")), siteRadiusM };
}

// ---------------- submission ----------------
export interface PartnerPhotoInput { bytes: Uint8Array; lat: number | null; lng: number | null; capturedAt: string | null }
export interface PartnerSubmissionInput {
  inspector: string;
  summary: string;
  answers: Record<string, { ok: boolean; note?: string }>;
  photos: PartnerPhotoInput[];
}

/** Single use: the token is consumed in the same update that moves the audit to `submitted`. */
export async function submitAuditByPartner(token: string, input: PartnerSubmissionInput, now = new Date()): Promise<{ auditId: string; flags: string[] }> {
  const a = await byToken(token, now);
  const inspector = input.inspector.trim(), summary = input.summary.trim();
  if (inspector.length < 2 || inspector.length > 120) throw new DomainError("validation", "Enter the inspector name.");
  if (summary.length < 10 || summary.length > 4000) throw new DomainError("validation", "Add a short summary of the visit (10 to 4000 characters).");
  if (input.photos.length < 1 || input.photos.length > MAX_AUDIT_PHOTOS) throw new DomainError("validation", `Upload between 1 and ${MAX_AUDIT_PHOTOS} photos.`);
  const checklist = auditChecklist();
  const answers: Record<string, { ok: boolean; note?: string }> = {};
  for (const item of checklist) {
    const x = input.answers[item.id];
    if (x) answers[item.id] = { ok: x.ok === true, ...(x.note ? { note: String(x.note).slice(0, 300) } : {}) };
  }
  for (const p of input.photos) {
    if (p.bytes.length > MAX_AUDIT_PHOTO_BYTES) throw new DomainError("validation", "A photo is larger than 6 MB.");
    if ((p.lat !== null && !(p.lat >= -90 && p.lat <= 90)) || (p.lng !== null && !(p.lng >= -180 && p.lng <= 180))) throw new DomainError("validation", "A photo has an invalid location.");
  }
  const ports = kycPorts();
  const inspected: { img: ReturnType<typeof ports.inspectImage>; p: PartnerPhotoInput }[] = [];
  for (const p of input.photos) {
    try { inspected.push({ img: ports.inspectImage(p.bytes), p }); } catch (err) { throw new DomainError("validation", err instanceof Error ? err.message : "A photo is not a valid image."); }
  }
  const evaluation = evaluateAuditSubmission({
    checklist, answers, now,
    photos: inspected.map(({ img, p }) => ({ sha256: img.sha256, lat: p.lat, lng: p.lng, capturedAt: p.capturedAt })),
  });
  const stored: { key: string; sha256: string; lat: number | null; lng: number | null; capturedAt: string | null; mime: string }[] = [];
  try {
    for (const { img, p } of inspected) {
      const key = `${AUDIT_PHOTO_PREFIX}${a.businessId}/${a.id}/photos/${randomUUID()}.${img.ext}`;
      await ports.store.put(key, p.bytes, img.mime);
      stored.push({ key, sha256: img.sha256, lat: p.lat, lng: p.lng, capturedAt: p.capturedAt, mime: img.mime });
    }
    const submission = { inspector, summary, answers, photos: stored, flags: evaluation.flags, checklistPassed: evaluation.checklistPassed, siteRadiusM: evaluation.siteRadiusM, checklist: checklist.map((c) => c.id) };
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.verificationAudit.updateMany({
        where: { id: a.id, uploadTokenHash: hashToken(token), status: { in: ["requested", "scheduled"] } },
        data: { status: "submitted", submittedAt: now, submission: submission as unknown as Prisma.InputJsonValue, uploadTokenHash: null, uploadTokenExpiresAt: null },
      });
      if (claimed.count === 0) throw new DomainError("conflict", "This audit was already submitted.");
      await emit(tx, "AuditSubmitted", { type: "Audit", id: a.id }, { auditId: a.id, businessId: a.businessId, partner: a.partner, photoCount: stored.length, flagged: evaluation.flags.length > 0 });
    });
  } catch (err) {
    for (const s of stored) await ports.store.delete(s.key).catch(() => {});
    throw err;
  }
  return { auditId: a.id, flags: evaluation.flags };
}

// ---------------- staff review ----------------
export interface AuditSubmissionDetail {
  auditId: string; businessId: string; partner: string; inspector: string; summary: string; submittedAt: string | null; flags: string[]; checklistPassed: boolean; siteRadiusM: number | null;
  checklist: { id: string; label: string; ok: boolean | null; note: string | null }[];
  photos: { index: number; lat: number | null; lng: number | null; capturedAt: string | null }[];
}
export async function getAuditSubmission(auditId: string): Promise<AuditSubmissionDetail | null> {
  const a = await load(auditId);
  const s = a.submission as { inspector: string; summary: string; answers: Record<string, { ok: boolean; note?: string }>; photos: { lat: number | null; lng: number | null; capturedAt: string | null; key?: string }[]; flags: string[]; checklistPassed: boolean; siteRadiusM: number | null } | null;
  if (!s) return null;
  const items = auditChecklist();
  return {
    auditId, businessId: a.businessId, partner: a.partner, inspector: s.inspector, summary: s.summary, submittedAt: a.submittedAt?.toISOString() ?? null, flags: s.flags, checklistPassed: s.checklistPassed, siteRadiusM: s.siteRadiusM,
    checklist: items.map((c) => ({ id: c.id, label: c.label, ok: s.answers[c.id]?.ok ?? null, note: s.answers[c.id]?.note ?? null })),
    photos: s.photos.map((p, index) => ({ index, lat: p.lat, lng: p.lng, capturedAt: p.capturedAt })),
  };
}
/** Staff-only photo read (admin route gated by audits.manage, no-store). */
export async function readAuditPhoto(auditId: string, index: number): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const a = await load(auditId);
  const key = (a.submission as { photos?: { key?: string }[] } | null)?.photos?.[index]?.key;
  return key ? kycPorts().store.get(key) : null;
}

/** Staff decision on a submitted audit; wrap in admin.audited("audits.manage"). A pass sets tier 3 until validUntil and the re-audit date. */
export async function reviewAuditSubmission(auditId: string, d: { result: AuditResult; validUntil: Date; note: string }, staffId: string, now = new Date()): Promise<AuditView> {
  const a = await load(auditId);
  if (a.status !== "submitted") throw new DomainError("conflict", "This audit has no partner submission to review.");
  if (!d.note.trim()) throw new DomainError("validation", "A review note is required.", undefined, "account.auditReviewNoteRequired");
  const sub = await getAuditSubmission(auditId);
  return recordAuditResult(auditId, {
    result: d.result, validUntil: d.validUntil, reviewNote: d.note,
    findings: { summary: sub?.summary ?? "", source: "partner_submission", inspector: sub?.inspector, photoCount: sub?.photos.length ?? 0, flags: sub?.flags ?? [], checklistPassed: sub?.checklistPassed ?? false, siteRadiusM: sub?.siteRadiusM ?? null },
  }, staffId, now);
}

/** The submission was unusable: reopens the audit (scheduled) so a new link can be issued; photos are deleted. */
export async function requestAuditResubmission(auditId: string, note: string): Promise<AuditView> {
  const a = await load(auditId);
  if (a.status !== "submitted") throw new DomainError("conflict", "Only a submitted audit can be sent back.");
  if (!note.trim()) throw new DomainError("validation", "A note for the partner is required.", undefined, "account.auditPartnerNoteRequired");
  const keys = ((a.submission as { photos?: { key?: string }[] } | null)?.photos ?? []).map((p) => p.key).filter((k): k is string => !!k);
  const claimed = await prisma.verificationAudit.updateMany({ where: { id: auditId, status: "submitted" }, data: { status: "scheduled", submission: Prisma.DbNull, submittedAt: null, reviewNote: note.trim() } });
  if (claimed.count === 0) throw new DomainError("conflict", "This audit was already decided.");
  for (const k of keys) await kycPorts().store.delete(k).catch(() => {});
  const { listAudits } = await import("./audits");
  return (await listAudits({ businessId: a.businessId })).find((x) => x.id === auditId)!;
}

/** Retention: deletes partner photos (and their coordinates) of audits decided before `before`; the checklist, summary and flags stay as the record. */
export async function purgeAuditPhotos(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const rows = await prisma.verificationAudit.findMany({ where: { status: { in: ["completed", "failed", "expired", "cancelled"] }, updatedAt: { lt: before } }, select: { id: true, submission: true } });
  const withPhotos = rows.filter((r) => ((r.submission as { photos?: unknown[] } | null)?.photos?.length ?? 0) > 0);
  if (opts.dryRun) return withPhotos.length;
  for (const r of withPhotos) {
    const s = r.submission as { photos: { key?: string }[] } & Record<string, unknown>;
    for (const p of s.photos) if (p.key) await kycPorts().store.delete(p.key).catch(() => {});
    await prisma.verificationAudit.update({ where: { id: r.id }, data: { submission: { ...s, photos: [], photosPurged: s.photos.length } as unknown as Prisma.InputJsonValue } });
  }
  return withPhotos.length;
}

/** Passing audits whose re-audit date has arrived (still valid): the admin queue and seller status show a re-audit prompt. */
export async function listReauditsDue(now = new Date()): Promise<AuditView[]> {
  const { listAudits } = await import("./audits");
  const rows = await prisma.verificationAudit.findMany({ where: { status: "completed", result: "pass", reAuditDueAt: { lte: now }, validUntil: { gt: now } }, select: { id: true, businessId: true }, take: 200 });
  if (!rows.length) return [];
  const all = await listAudits({ limit: 200 });
  const ids = new Set(rows.map((r) => r.id));
  return all.filter((a) => ids.has(a.id));
}

export { OPEN as AUDIT_OPEN_STATUSES };
