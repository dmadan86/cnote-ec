// EmailMessage delivery log for staff tools (the email module owns EmailMessage). Masked recipients only; bodies
// are never stored, and addresses inside provider error text are masked too.
import { prisma } from "@cnote/db";

export interface EmailLogEntry {
  id: string;
  toMasked: string;
  template: string;
  category: string;
  subject: string;
  status: string;
  provider: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export const EMAIL_STATUSES = ["queued", "sending", "sent", "failed", "suppressed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const EMAIL_IN_TEXT = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/** Masks every address inside free text ("user@x.in" → "u***@x.in"). */
export const maskEmailsInText = (s: string): string => s.replace(EMAIL_IN_TEXT, "$1***$2");

/** Newest first, keyset-paged by (createdAt, id). */
export async function listEmailLog(
  filters: { status?: string; template?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: EmailLogEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const status = EMAIL_STATUSES.find((s) => s === filters.status);
  const rows = await prisma.emailMessage.findMany({
    where: { ...(status ? { status } : {}), ...(filters.template ? { template: { contains: filters.template, mode: "insensitive" } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      id: r.id, toMasked: r.toMasked, template: r.template, category: r.category, subject: r.subject, status: r.status,
      provider: r.provider, attempts: r.attempts, lastError: r.lastError ? maskEmailsInText(r.lastError).slice(0, 300) : null,
      createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
