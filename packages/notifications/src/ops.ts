// Ops helpers for the admin queue console (privilege checks + audit happen in apps/admin).
import { getJobQueue, type JobTopic, type QueueMessage } from "@cnote/core";
import { prisma } from "@cnote/db";

export interface QueueTopicInfo {
  topic: string;
  description: string;
}

const topics = new Map<string, string>([
  ["email.send", "Outbound email (@cnote/email)"],
  ["notification.deliver", "Email / WhatsApp / SMS fan-out for notifications"],
]);

/** Other modules that add a JobTopic can also list it in the console. */
export function registerQueueTopic(topic: string, description: string): void {
  topics.set(topic, description);
}
export function listQueueTopics(): QueueTopicInfo[] {
  return [...topics].map(([topic, description]) => ({ topic, description }));
}

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g;
export function maskEmail(s: string): string {
  return s.replace(EMAIL_RE, (m) => `${m[0]}***@${m.split("@")[1]}`);
}
/** Dead-letter payloads may hold raw addresses/phones: mask before showing them to staff. */
export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") return /phone|mobile/i.test(key) ? `${value.slice(0, 3)}******${value.slice(-2)}` : maskEmail(value);
  if (Array.isArray(value)) return value.map((x) => redact(x, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, redact(x, k)]));
  return value;
}

export async function listDeadLetters(topic: string, limit = 50): Promise<QueueMessage[]> {
  const msgs = await getJobQueue().deadLetters(topic, limit);
  return msgs.map((m) => ({ ...m, payload: redact(m.payload) }));
}
export async function replayDeadLetter(topic: string, id: string): Promise<boolean> {
  return getJobQueue().replayDeadLetter(topic, id);
}
export type { JobTopic };

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
const STATUSES = ["queued", "sending", "sent", "failed", "suppressed"] as const;
export type EmailStatus = (typeof STATUSES)[number];
export const EMAIL_STATUSES = STATUSES;

/** EmailMessage delivery log, newest first. Masked recipient only; bodies are never stored. */
export async function listEmailLog(filters: { status?: string; template?: string; cursor?: string; limit?: number } = {}): Promise<{ items: EmailLogEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const status = STATUSES.find((s) => s === filters.status);
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
      provider: r.provider, attempts: r.attempts, lastError: r.lastError ? maskEmail(r.lastError).slice(0, 300) : null,
      createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
