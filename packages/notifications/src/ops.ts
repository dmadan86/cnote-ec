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

// The email delivery log belongs to @cnote/email (it owns EmailMessage); re-exported here for the admin queues pages.
export { EMAIL_STATUSES, listEmailLog, type EmailLogEntry, type EmailStatus } from "@cnote/email";
