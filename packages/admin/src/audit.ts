import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { type AdminContext, hasPrivilege, requirePrivilege } from "./context";
import type { Privilege } from "./rbac";

export interface AuditSubject {
  type?: string | null;
  id?: string | null;
}

export interface AuditEntryView {
  id: string;
  staffId: string | null;
  privilege: string;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

const MAX_TEXT = 500;
const clip = (s: string | null | undefined) => (s == null ? null : s.slice(0, MAX_TEXT));

/** Low-level append. Prefer `audited()`; the CLI uses this directly with staffId null. */
export async function writeAudit(entry: {
  staffId: string | null;
  privilege: string;
  action: string;
  subject?: AuditSubject;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      staffId: entry.staffId,
      privilege: entry.privilege,
      action: entry.action,
      subjectType: clip(entry.subject?.type),
      subjectId: clip(entry.subject?.id),
      // round-trip guarantees JSON-serialisable content (drops undefined, throws on cycles)
      details: JSON.parse(JSON.stringify(entry.details ?? {})),
      ip: clip(entry.ip),
      userAgent: clip(entry.userAgent),
    },
  });
}

/**
 * The ONLY sanctioned way to perform a privileged action:
 *  1. checks `privilege` (denials are audited best-effort, then throw forbidden),
 *  2. runs `fn`,
 *  3. appends an AdminAuditLog row — on success, and on failure (details.error) before rethrowing.
 * Returns fn's result. If the audit write fails after a successful fn, the error propagates so the
 * operator knows the trail is incomplete (the action itself has already happened).
 */
export async function audited<T>(
  ctx: AdminContext,
  privilege: Privilege,
  action: string,
  subject: AuditSubject,
  fn: () => Promise<T>,
  details: Record<string, unknown> = {},
): Promise<T> {
  const base = { staffId: ctx.staff.id, privilege, action, subject, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null };
  if (!hasPrivilege(ctx.staff, privilege)) {
    await writeAudit({ ...base, details: { ...details, denied: true } }).catch((e) => console.error("[admin] audit write failed", e));
    requirePrivilege(ctx.staff, privilege); // throws
  }
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof DomainError ? err.code : undefined;
    await writeAudit({ ...base, details: { ...details, error: message.slice(0, MAX_TEXT), ...(code ? { errorCode: code } : {}) } }).catch((e) =>
      console.error("[admin] audit write failed", e),
    );
    throw err;
  }
  await writeAudit({ ...base, details });
  return result;
}

const filtersSchema = z.object({
  staffId: z.uuid().optional(),
  privilege: z.string().max(100).optional(),
  action: z.string().max(200).optional(),
  subjectType: z.string().max(100).optional(),
  subjectId: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type AuditFilters = z.input<typeof filtersSchema>;

/** Newest first. Cursor = id of the last row of the previous page. Requires audit.read. */
export async function listAuditLog(ctx: AdminContext, filters: AuditFilters = {}): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
  requirePrivilege(ctx.staff, "audit.read");
  const f = filtersSchema.parse(filters);
  const rows = await prisma.adminAuditLog.findMany({
    where: {
      staffId: f.staffId,
      privilege: f.privilege,
      // exact match, or prefix when the filter ends with "*"
      action: f.action ? (f.action.endsWith("*") ? { startsWith: f.action.slice(0, -1) } : f.action) : undefined,
      subjectType: f.subjectType,
      subjectId: f.subjectId,
      createdAt: f.from || f.to ? { gte: f.from, lte: f.to } : undefined,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      staffId: r.staffId,
      privilege: r.privilege,
      action: r.action,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      details: (r.details ?? {}) as Record<string, unknown>,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: rows.length > f.limit ? page[page.length - 1]!.id : null,
  };
}
