// @cnote/email — outbound email via the JobQueue ("email.send"), provider factory
// (EMAIL_PROVIDER=console|smtp|ses|resend), content from @cnote/templates.
// PUBLIC CONTRACT. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";

export interface SendEmailInput {
  template: string; // template key
  to: { email: string; personId?: string | null; name?: string | null };
  vars: Record<string, unknown>;
  locale?: string;
  /** idempotency: the same logical email is sent at most once */
  dedupeKey?: string;
  delayMs?: number;
}

/**
 * Queue an email. Checks consent for marketing templates (identity), suppresses erased
 * recipients, writes an EmailMessage row (status queued) and enqueues "email.send".
 * Returns the EmailMessage id, or null when suppressed/deduped.
 */
export async function sendEmail(input: SendEmailInput): Promise<string | null> {
  void input;
  throw new Error("not implemented");
}

/** Render + send immediately, bypassing the queue — admin "send test" only. */
export async function sendTestEmail(template: string, toEmail: string, vars: Record<string, unknown>, opts?: { versionId?: string; layoutVersionId?: string }): Promise<{ provider: string; messageId: string }> {
  void template; void toEmail; void vars; void opts;
  throw new Error("not implemented");
}

export const worker: ModuleWorker = { name: "email", handlers: {}, jobs: [] };
