// @cnote/email — outbound email via the JobQueue ("email.send"), provider factory
// (EMAIL_PROVIDER=console|smtp|ses|resend), content from @cnote/templates.
// PUBLIC CONTRACT. Extend, don't break.
import { DomainError, getJobQueue, queueConsumer, type ModuleWorker, type QueueMessage } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hasConsent, isPersonErased, type Mailer } from "@cnote/identity";
import { exampleVars, getTemplateDefinition, renderEmail } from "@cnote/templates";
import { randomUUID } from "node:crypto";
import { PermanentEmailError, fromAddress, getEmailProvider } from "./providers";
import "./templates";

export { PermanentEmailError, createEmailProvider, getEmailProvider, setEmailProvider, type EmailProvider, type EmailProviderName, type OutgoingEmail } from "./providers";

export interface EmailJob {
  messageId: string;
  /** raw address: only ever lives in the queued job, never in the database */
  to: string;
  toName?: string | null;
  template: string;
  vars: Record<string, unknown>;
  locale?: string;
}

declare module "@cnote/core" {
  interface JobTopics {
    "email.send": EmailJob;
  }
}

export interface SendEmailInput {
  template: string; // template key
  to: { email: string; personId?: string | null; name?: string | null };
  vars: Record<string, unknown>;
  locale?: string;
  /** idempotency: the same logical email is sent at most once */
  dedupeKey?: string;
  delayMs?: number;
}

/** "asha@gmail.com" → "a***@gmail.com" (support-friendly, not reversible). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

const isErased = isPersonErased; // identity's public accessor (unknown or erased persons are suppressed)

/**
 * Queue an email. Checks consent for marketing templates (identity), suppresses erased
 * recipients, writes an EmailMessage row (status queued) and enqueues "email.send".
 * Returns the EmailMessage id, or null when suppressed/deduped.
 */
export async function sendEmail(input: SendEmailInput): Promise<string | null> {
  const def = getTemplateDefinition(input.template);
  if (!def) throw new DomainError("validation", `Unknown email template "${input.template}"`);
  const email = input.to.email.trim();
  if (!ADDRESS.test(email) || email.length > 254) throw new DomainError("validation", "Invalid recipient address.");
  const personId = input.to.personId ?? null;

  let suppressed: string | null = null;
  if (personId && (await isErased(personId))) suppressed = "recipient erased";
  else if (def.category === "marketing" && (!personId || !(await hasConsent(personId, "marketing")))) suppressed = "no marketing consent";

  const base = {
    toPersonId: personId,
    toMasked: maskEmail(email),
    template: input.template,
    category: def.category,
    subject: def.defaults.email?.subject ?? def.name,
    dedupeKey: input.dedupeKey ?? null,
  };

  if (suppressed) {
    try {
      await prisma.emailMessage.create({ data: { ...base, status: "suppressed", lastError: suppressed } });
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
    return null;
  }

  let row: { id: string };
  try {
    row = await prisma.emailMessage.create({ data: { ...base, status: "queued" }, select: { id: true } });
  } catch (e) {
    if (isUnique(e)) return null; // same dedupeKey already recorded
    throw e;
  }

  let vars: Record<string, unknown>;
  try {
    vars = JSON.parse(JSON.stringify(input.vars)) as Record<string, unknown>; // queue payloads must be JSON
  } catch {
    await prisma.emailMessage.update({ where: { id: row.id }, data: { status: "failed", lastError: "variables are not serialisable" } });
    throw new DomainError("validation", "Email variables must be JSON-serialisable.");
  }
  try {
    await getJobQueue().enqueue(
      "email.send",
      { messageId: row.id, to: email, toName: input.to.name ?? null, template: input.template, vars, locale: input.locale },
      { delayMs: input.delayMs, dedupeKey: input.dedupeKey ? `email:${input.dedupeKey}` : undefined },
    );
  } catch (err) {
    await prisma.emailMessage.update({ where: { id: row.id }, data: { status: "failed", lastError: `enqueue failed: ${errorMessage(err)}` } });
    throw err;
  }
  return row.id;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** Queue consumer: renders at send time (so template edits apply to queued mail), sends, records the outcome. */
export async function handleEmailSend(msg: QueueMessage<EmailJob>): Promise<void> {
  const job = msg.payload;
  const row = await prisma.emailMessage.findUnique({ where: { id: job.messageId } });
  if (!row || row.status === "sent" || row.status === "suppressed") return; // at-least-once delivery → idempotent
  await prisma.emailMessage.update({ where: { id: row.id }, data: { status: "sending", attempts: { increment: 1 } } });

  const fail = (error: string) => prisma.emailMessage.update({ where: { id: row.id }, data: { status: "failed", lastError: error.slice(0, 500) } });

  let rendered;
  try {
    rendered = await renderEmail(job.template, job.vars, { locale: job.locale });
  } catch (err) {
    if (err instanceof DomainError) {
      await fail(`render: ${err.message}`); // missing variable / unknown template: retrying can't help
      return;
    }
    await retryOrFail(msg, row.id, err);
    return;
  }

  const headers: Record<string, string> = {};
  if (row.category === "marketing") {
    const url = typeof job.vars.unsubscribeUrl === "string" ? job.vars.unsubscribeUrl : `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/account/notifications`;
    headers["List-Unsubscribe"] = `<${url}>`;
  }
  const provider = getEmailProvider();
  try {
    const res = await provider.send({ id: row.id, to: job.to, toName: job.toName, from: fromAddress(), subject: rendered.subject, html: rendered.html, text: rendered.text, headers });
    await prisma.emailMessage.update({
      where: { id: row.id },
      data: { status: "sent", sentAt: new Date(), provider: provider.name, providerMessageId: res.messageId, subject: rendered.subject.slice(0, 300), lastError: null },
    });
  } catch (err) {
    if (err instanceof PermanentEmailError) {
      await fail(err.message);
      return;
    }
    await retryOrFail(msg, row.id, err);
  }
}

/** Transient failure: rethrow so the queue retries with backoff; on the last attempt record `failed` first. */
async function retryOrFail(msg: QueueMessage<EmailJob>, id: string, err: unknown): Promise<never> {
  const last = msg.attempt >= msg.maxAttempts;
  await prisma.emailMessage.update({ where: { id }, data: { status: last ? "failed" : "queued", lastError: errorMessage(err) } });
  throw err;
}

/** Render + send immediately, bypassing the queue — admin "send test" only. Not recorded in EmailMessage. */
export async function sendTestEmail(template: string, toEmail: string, vars: Record<string, unknown>, opts?: { versionId?: string; layoutVersionId?: string }): Promise<{ provider: string; messageId: string }> {
  const def = getTemplateDefinition(template);
  if (!def) throw new DomainError("validation", `Unknown email template "${template}"`);
  if (!ADDRESS.test(toEmail.trim())) throw new DomainError("validation", "Invalid recipient address.");
  const rendered = await renderEmail(template, { ...exampleVars(def), ...vars }, { versionId: opts?.versionId, layoutVersionId: opts?.layoutVersionId });
  const provider = getEmailProvider();
  const res = await provider.send({ id: randomUUID(), to: toEmail.trim(), from: fromAddress(), subject: `[Test] ${rendered.subject}`, html: rendered.html, text: rendered.text });
  return { provider: provider.name, messageId: res.messageId };
}

/**
 * identity's Mailer backed by the queue: password-reset mail goes through "auth.password_reset" (the reset link is
 * lifted from the message text); anything else is sent as a plain "system.message".
 */
export function createQueuedMailer(): Mailer {
  return {
    async send({ to, subject, text }) {
      const url = text.match(/https?:\/\/[^\s<>"]+/)?.[0];
      if (url && /reset/i.test(subject)) {
        await sendEmail({ template: "auth.password_reset", to: { email: to }, vars: { resetUrl: url, expiresInMinutes: "30" } });
      } else {
        await sendEmail({ template: "system.message", to: { email: to }, vars: { subject, message: text } });
      }
    },
  };
}

export const worker: ModuleWorker = {
  name: "email",
  handlers: {},
  jobs: [],
  queues: [queueConsumer("email.send", handleEmailSend, 2)],
};
