// DPDP grievance redressal + IT Rules 2021 r.3(2) grievance officer workflow (ADR-010).
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { enqueueAccountMail } from "@cnote/identity";
import { z } from "zod";
import { grievancePolicy } from "./config";
import { anonymizeCookieConsentReceipts } from "./consent";
import { isUuid, maskEmail, parse } from "./util";

export const GRIEVANCE_CATEGORIES = ["access", "correction", "erasure", "consent", "content", "report", "other"] as const;
// "report" = abuse / IPR takedown notice filed from the public /report page (IT Rules 2021 r.3(1)(d)); same ticket queue.
export type GrievanceCategory = (typeof GRIEVANCE_CATEGORIES)[number];
/**
 * What the person is asking for. The first five are data-principal RIGHTS (DPDP Act ss.11-14: access, correction/erasure,
 * grievance redressal, nomination; s.6(4) withdrawal of consent) with the longer rights-request SLA; "complaint" is a
 * grievance about content, consent handling or anything else and follows the grievance SLA.
 */
export const REQUEST_TYPES = ["access", "correction", "erasure", "nomination", "withdraw_consent", "complaint"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const isRightsRequest = (t: string): boolean => t !== "complaint";
export type GrievanceStatus = "open" | "in_progress" | "resolved" | "rejected";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DUE_SOON_MS = 3 * DAY;
/** A takedown notice's 36h window is short: "due soon" is the last 6 hours. */
const TAKEDOWN_DUE_SOON_MS = 6 * HOUR;
export const TAKEDOWN_CATEGORY = "report";
export const isTakedown = (category: string | undefined): boolean => category === TAKEDOWN_CATEGORY;

export interface GrievanceSla {
  /** "rights" requests are due in 90 days, "complaint"s follow the grievance policy, "takedown" notices (category "report") are acted on within 36 hours */
  kind: "rights" | "complaint" | "takedown";
  /** whole days until dueAt (negative = overdue); null once the ticket is closed */
  daysLeft: number | null;
  /** whole hours until dueAt (negative = overdue); null once the ticket is closed. The unit that matters for takedowns. */
  hoursLeft: number | null;
  /** "pending" = still open inside the window; "breached" = still open past the acknowledgement window */
  acknowledgement: "done" | "pending" | "breached";
  resolution: "closed" | "on_track" | "due_soon" | "breached";
}

export interface GrievanceView {
  id: string;
  personId: string | null;
  /** masked ("a***@x.com"); the raw address is never returned by this module */
  contactEmail: string | null;
  category: string;
  requestType: RequestType;
  /** days allowed to resolve, fixed when the ticket was filed */
  slaDays: number;
  /** cookie consent id the raiser referred to (32 hex), if any */
  consentId: string | null;
  subject: string;
  body: string;
  status: GrievanceStatus;
  dueAt: string;
  resolution: string | null;
  handledBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** the raiser proved control of the contact email (signed link) or was signed in; staff only act on verified requests */
  requesterVerified: boolean;
  sla: GrievanceSla;
}

type Row = Prisma.GrievanceTicketGetPayload<object>;

/** Pure SLA evaluation (injectable clock). Acknowledgement = the ticket has left "open". */
export function evaluateSla(t: Pick<Row, "status" | "createdAt" | "dueAt"> & { requestType?: string; category?: string }, now: Date, ackHoursOverride?: number): GrievanceSla {
  const policy = grievancePolicy();
  const takedown = isTakedown(t.category);
  const ackHours = ackHoursOverride ?? (takedown ? policy.takedownAckHours : policy.ackHours);
  const dueSoonMs = takedown ? TAKEDOWN_DUE_SOON_MS : DUE_SOON_MS;
  const closed = t.status === "resolved" || t.status === "rejected";
  const acknowledgement = t.status !== "open" ? "done" : now.getTime() > t.createdAt.getTime() + ackHours * HOUR ? "breached" : "pending";
  const resolution = closed ? "closed" : now.getTime() > t.dueAt.getTime() ? "breached" : t.dueAt.getTime() - now.getTime() <= dueSoonMs ? "due_soon" : "on_track";
  const daysLeft = closed ? null : Math.floor((t.dueAt.getTime() - now.getTime()) / DAY);
  const hoursLeft = closed ? null : Math.floor((t.dueAt.getTime() - now.getTime()) / HOUR);
  const kind = takedown ? "takedown" : isRightsRequest(t.requestType ?? "complaint") ? "rights" : "complaint";
  return { kind, daysLeft, hoursLeft, acknowledgement, resolution };
}

const view = (r: Row, now: Date): GrievanceView => ({
  id: r.id,
  personId: r.personId,
  contactEmail: maskEmail(r.contactEmail),
  category: r.category,
  requestType: r.requestType as RequestType,
  slaDays: r.slaDays,
  consentId: r.consentId,
  subject: r.subject,
  body: r.body,
  status: r.status,
  dueAt: r.dueAt.toISOString(),
  resolution: r.resolution,
  handledBy: r.handledBy,
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  requesterVerified: !!r.contactVerifiedAt,
  // An unverified request cannot be acknowledged yet, so staff are never shown as late on it (the clock restarts at verification).
  sla: r.contactVerifiedAt ? evaluateSla(r, now) : { ...evaluateSla(r, now), acknowledgement: "pending" },
});

const fileSchema = z.object({
  personId: z.uuid().optional(),
  contactEmail: z.email("Enter a valid email address").max(254).optional(),
  /** the right being exercised, or "complaint". Omitted = derived from `category` (legacy callers) */
  requestType: z.enum(REQUEST_TYPES, "Choose a request type").optional(),
  /** content/consent/other for complaints; derived from `requestType` for rights requests when omitted */
  category: z.enum(GRIEVANCE_CATEGORIES, "Choose a category").optional(),
  consentId: z.string().trim().toLowerCase().regex(/^[a-f0-9]{32}$/, "A consent ID is 32 characters (0-9, a-f)").optional(),
  subject: z.string().trim().min(3, "Add a short subject").max(200),
  body: z.string().trim().min(10, "Describe your grievance (at least 10 characters)").max(5000),
});
export type FileGrievanceInput = z.input<typeof fileSchema>;

const CATEGORY_OF: Record<RequestType, GrievanceCategory> = { access: "access", correction: "correction", erasure: "erasure", nomination: "other", withdraw_consent: "consent", complaint: "other" };
const LEGACY_TYPE: Partial<Record<GrievanceCategory, RequestType>> = { access: "access", correction: "correction", erasure: "erasure" };

// ---- requester email verification (anonymous rights requests) ----
const VERIFY_TTL_MS = 7 * DAY;
const verifyKey = () => {
  const secret = process.env.GRIEVANCE_VERIFY_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET (or GRIEVANCE_VERIFY_SECRET) must be set and at least 32 characters long");
  return Buffer.from(hkdfSync("sha256", secret, "cnote-grievance", "grievance-email-verification", 32));
};
const verifySig = (ticketId: string, email: string, exp: number) => createHmac("sha256", verifyKey()).update(`${ticketId}:${email.toLowerCase()}:${exp}`).digest("base64url");

/** Signed, expiring proof that the holder received the mail sent to `email` for this ticket: `<exp>.<signature>`. */
export function grievanceVerifyToken(ticketId: string, email: string, now = new Date()): string {
  const exp = now.getTime() + VERIFY_TTL_MS;
  return `${exp}.${verifySig(ticketId, email, exp)}`;
}

/** An anonymous data-rights request (not a complaint or takedown notice) must prove control of its contact email first. */
const needsEmailVerification = (personId: string | undefined, requestType: RequestType, takedown: boolean) => !personId && isRightsRequest(requestType) && !takedown;

const verifyLink = (ticketId: string, token: string) => `${process.env.APP_URL ?? "http://localhost:3000"}/grievance/verify?ticket=${ticketId}&token=${encodeURIComponent(token)}`;

/**
 * Confirms the contact email of an anonymous rights request from the signed link. Idempotent. The statutory clock starts now
 * (dueAt = now + slaDays) because the request only becomes actionable at this point. Wrong/expired/forged links are a generic error.
 */
export async function verifyGrievanceContact(ticketId: string, token: string, now = new Date()): Promise<{ verified: true; dueAt: string }> {
  const bad = () => new DomainError("validation", "This confirmation link is invalid or has expired.");
  if (!isUuid(ticketId) || typeof token !== "string") throw bad();
  const t = await prisma.grievanceTicket.findUnique({ where: { id: ticketId } });
  if (!t?.contactEmail) throw bad();
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!sig || !Number.isFinite(exp)) throw bad();
  const expected = verifySig(ticketId, t.contactEmail, exp);
  // Compare the canonical base64url signature strings (not decoded bytes) in constant time.
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw bad();
  if (exp < now.getTime()) throw bad();
  if (t.contactVerifiedAt) return { verified: true, dueAt: t.dueAt.toISOString() };
  if (t.status === "rejected" || t.status === "resolved") throw bad();
  const dueAt = t.category === TAKEDOWN_CATEGORY ? t.dueAt : new Date(now.getTime() + t.slaDays * DAY);
  await prisma.grievanceTicket.updateMany({ where: { id: ticketId, contactVerifiedAt: null }, data: { contactVerifiedAt: now, dueAt } });
  return { verified: true, dueAt: dueAt.toISOString() };
}

/** File a grievance (signed-in or anonymous with a contact email). Rate limited per raiser; dueAt from policy. */
export async function fileGrievance(input: FileGrievanceInput, now = new Date()): Promise<GrievanceView> {
  const i = parse(fileSchema, input);
  if (!i.requestType && !i.category) throw new DomainError("validation", "Choose a category", { field: "category" });
  const requestType: RequestType = i.requestType ?? LEGACY_TYPE[i.category!] ?? "complaint";
  const category: GrievanceCategory = i.category ?? CATEGORY_OF[requestType];
  if (!i.personId && !i.contactEmail) throw new DomainError("validation", "Provide a contact email so we can reply", { field: "contactEmail" }, "compliance.provideContactEmailReply");
  const policy = grievancePolicy();
  const key = `grievance:${i.personId ?? i.contactEmail!.toLowerCase()}`;
  if (!(await rateLimit(key, policy.perHourLimit, 3600))) throw new DomainError("rate_limited", "Too many grievances submitted. Please try again later.", undefined, "compliance.tooManyGrievancesSubmittedTry");
  // Takedown notices (category "report") must be ACTED on within 36h (IT Rules 2021 r.3(1)(d)), so dueAt is hour-based;
  // slaDays is a whole-day column and holds that window rounded up (2).
  const takedown = isTakedown(category);
  const slaDays = takedown ? Math.ceil(policy.takedownActHours / 24) : isRightsRequest(requestType) ? policy.rightsRequestDays : policy.resolveDays;
  const dueAt = takedown ? new Date(now.getTime() + policy.takedownActHours * HOUR) : new Date(now.getTime() + slaDays * DAY);
  const verifyFirst = needsEmailVerification(i.personId, requestType, takedown);
  const row = await prisma.$transaction(async (tx) => {
    const t = await tx.grievanceTicket.create({
      data: {
        personId: i.personId ?? null,
        contactEmail: i.contactEmail?.toLowerCase() ?? null,
        category,
        requestType,
        slaDays,
        consentId: i.consentId ?? null,
        subject: i.subject,
        body: i.body,
        dueAt,
        createdAt: now,
        contactVerifiedAt: verifyFirst ? null : now,
      },
    });
    await emit(tx, "GrievanceFiled", { type: "GrievanceTicket", id: t.id }, { ticketId: t.id, personId: t.personId, category: t.category, dueAt: dueAt.toISOString() });
    return t;
  });
  if (verifyFirst && row.contactEmail) {
    // Enqueued (not awaited on the request path): the ticket exists but is not actionable until the link is used.
    await enqueueAccountMail({
      to: row.contactEmail,
      subject: "Confirm your data request",
      text: `We received a data request (reference ${row.id}) using this email address.\nConfirm it is yours by opening this link within 7 days; we cannot act on the request until you do:\n${verifyLink(row.id, grievanceVerifyToken(row.id, row.contactEmail, now))}\nIf you did not make this request, ignore this email and nothing will happen.`,
    });
  }
  return view(row, now);
}

export interface GrievanceFilters {
  status?: GrievanceStatus;
  category?: string;
  requestType?: RequestType;
  /** only data-rights requests (everything except "complaint"); without `status`, only those still open or in progress */
  rightsOnly?: boolean;
  /** only tickets still open or in progress (the working queue) */
  openOnly?: boolean;
  /** only tickets breaching an SLA right now */
  breachedOnly?: boolean;
  limit?: number;
}

/** Staff queue: oldest due first, contacts masked. */
export async function listGrievances(f: GrievanceFilters = {}, now = new Date()): Promise<GrievanceView[]> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const policy = grievancePolicy();
  const where: Prisma.GrievanceTicketWhereInput = { status: f.status, category: f.category, requestType: f.requestType };
  if (f.rightsOnly) {
    where.requestType = { not: "complaint" };
    if (!f.status) where.status = { in: ["open", "in_progress"] };
  }
  if (f.openOnly && !f.status) where.status = { in: ["open", "in_progress"] };
  if (f.breachedOnly) {
    where.contactVerifiedAt = { not: null };
    where.OR = [
      { status: "open", category: { not: TAKEDOWN_CATEGORY }, createdAt: { lt: new Date(now.getTime() - policy.ackHours * HOUR) } },
      { status: "open", category: TAKEDOWN_CATEGORY, createdAt: { lt: new Date(now.getTime() - policy.takedownAckHours * HOUR) } },
      { status: { in: ["open", "in_progress"] }, dueAt: { lt: now } },
    ];
  }
  const rows = await prisma.grievanceTicket.findMany({ where, orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: limit });
  return rows.map((r) => view(r, now));
}

export async function getGrievance(id: string, now = new Date()): Promise<GrievanceView | null> {
  if (!isUuid(id)) return null;
  const r = await prisma.grievanceTicket.findUnique({ where: { id } });
  return r ? view(r, now) : null;
}

/** The raiser's own tickets, newest first (the account page). */
export async function listMyGrievances(personId: string, now = new Date()): Promise<GrievanceView[]> {
  if (!isUuid(personId)) return [];
  const rows = await prisma.grievanceTicket.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((r) => view(r, now));
}

/** One of the raiser's own tickets; null for someone else's (no existence leak). */
export async function getMyGrievance(personId: string, id: string, now = new Date()): Promise<GrievanceView | null> {
  if (!isUuid(id) || !isUuid(personId)) return null;
  const r = await prisma.grievanceTicket.findFirst({ where: { id, personId } });
  return r ? view(r, now) : null;
}

const respondSchema = z.object({
  status: z.enum(["in_progress", "resolved", "rejected"]),
  resolution: z.string().trim().max(5000).optional(),
});

/**
 * Grievance Officer action. "in_progress" acknowledges; "resolved"/"rejected" close the ticket and require a
 * resolution text the raiser will see. Call inside admin.audited(ctx, "compliance.manage", ...).
 */
export async function respondToGrievance(id: string, input: z.input<typeof respondSchema>, staffId: string, now = new Date()): Promise<GrievanceView> {
  const i = parse(respondSchema, input);
  if (!isUuid(staffId)) throw new DomainError("forbidden", "Staff member required");
  const closing = i.status !== "in_progress";
  if (closing && (i.resolution?.length ?? 0) < 5) throw new DomainError("validation", "Write a resolution the person will see (at least 5 characters)", { field: "resolution" });
  const t = isUuid(id) ? await prisma.grievanceTicket.findUnique({ where: { id } }) : null;
  if (!t) throw new DomainError("not_found", "Grievance not found", undefined, "compliance.grievanceNotFound");
  if (t.status === "resolved" || t.status === "rejected") throw new DomainError("conflict", `Grievance is already ${t.status}`);
  // An anonymous rights request is not actionable until the requester proved control of the email (rejecting it is always allowed).
  if (!t.contactVerifiedAt && i.status !== "rejected") throw new DomainError("conflict", "The requester has not verified their email yet, so this request is not actionable. Wait for the confirmation, or reject it.");
  const row = await prisma.$transaction(async (tx) => {
    const res = await tx.grievanceTicket.updateMany({
      where: { id, status: { in: ["open", "in_progress"] } },
      data: { status: i.status, handledBy: staffId, ...(i.resolution ? { resolution: i.resolution } : {}), ...(closing ? { resolvedAt: now } : {}) },
    });
    if (res.count === 0) throw new DomainError("conflict", "Grievance was already closed");
    // Erasure carried out: detach the person from their cookie-consent receipts, keep the anonymous proof (DPDP s.8(7)).
    if (i.status === "resolved" && t.requestType === "erasure" && t.personId) await anonymizeCookieConsentReceipts(t.personId, tx);
    if (closing) await emit(tx, "GrievanceResolved", { type: "GrievanceTicket", id }, { ticketId: id, personId: t.personId, status: i.status as "resolved" | "rejected" });
    return tx.grievanceTicket.findUniqueOrThrow({ where: { id } });
  });
  return view(row, now);
}

export interface SlaSweepResult {
  ackBreached: number;
  resolutionBreached: number;
  dueSoon: number;
  /** anonymous rights requests closed because the email was never confirmed within the link's lifetime */
  unverifiedExpired?: number;
}

/** Closes anonymous rights requests whose email was not confirmed within the link lifetime (nothing was ever done on them). */
async function expireUnverified(now: Date): Promise<number> {
  const stale = await prisma.grievanceTicket.findMany({
    where: { status: "open", contactVerifiedAt: null, createdAt: { lt: new Date(now.getTime() - VERIFY_TTL_MS) } },
    select: { id: true, personId: true },
    take: 200,
  });
  let n = 0;
  for (const t of stale) {
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.grievanceTicket.updateMany({
        where: { id: t.id, status: "open", contactVerifiedAt: null },
        data: { status: "rejected", resolvedAt: now, resolution: "The email address was not confirmed within 7 days, so no action was taken. File a new request if you still need it." },
      });
      if (r.count === 0) return false;
      await emit(tx, "GrievanceResolved", { type: "GrievanceTicket", id: t.id }, { ticketId: t.id, personId: t.personId, status: "rejected" });
      return true;
    });
    if (done) n++;
  }
  return n;
}

/**
 * Scheduled job: counts tickets past their acknowledgement / resolution windows (and those due within 3 days).
 * Emits nothing; the breaches surface in the admin grievance queue (SLA badges). Logs a warning for the on-call.
 */
export async function sweepGrievanceSla(now = new Date()): Promise<SlaSweepResult> {
  const { ackHours, takedownAckHours } = grievancePolicy();
  const unverifiedExpired = await expireUnverified(now);
  const live = { in: ["open", "in_progress"] as GrievanceStatus[] };
  const [ackBreached, resolutionBreached, dueSoon] = await Promise.all([
    prisma.grievanceTicket.count({
      where: {
        status: "open",
        contactVerifiedAt: { not: null },
        OR: [
          { category: { not: TAKEDOWN_CATEGORY }, createdAt: { lt: new Date(now.getTime() - ackHours * HOUR) } },
          { category: TAKEDOWN_CATEGORY, createdAt: { lt: new Date(now.getTime() - takedownAckHours * HOUR) } },
        ],
      },
    }),
    prisma.grievanceTicket.count({ where: { status: live, contactVerifiedAt: { not: null }, dueAt: { lt: now } } }),
    prisma.grievanceTicket.count({
      where: {
        status: live,
        contactVerifiedAt: { not: null },
        dueAt: { gte: now },
        OR: [
          { category: { not: TAKEDOWN_CATEGORY }, dueAt: { lte: new Date(now.getTime() + DUE_SOON_MS) } },
          { category: TAKEDOWN_CATEGORY, dueAt: { lte: new Date(now.getTime() + TAKEDOWN_DUE_SOON_MS) } },
        ],
      },
    }),
  ]);
  if (ackBreached || resolutionBreached) console.warn(`[compliance] grievance SLA breach: ack=${ackBreached} resolution=${resolutionBreached} dueSoon=${dueSoon}`);
  return { ackBreached, resolutionBreached, dueSoon, ...(unverifiedExpired ? { unverifiedExpired } : {}) };
}
