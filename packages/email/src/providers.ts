import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface OutgoingEmail {
  /** EmailMessage id (or a fresh uuid for test sends) */
  id: string;
  to: string;
  toName?: string | null;
  from: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<{ messageId: string }>;
}

/** Non-retryable failure (bad address, rejected content): the message is marked failed without retry. */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEmailError";
  }
}

function repoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Dev default: logs subject/to and writes the rendered HTML to <repo>/.data/mail/<id>.html for local preview. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  async send(msg: OutgoingEmail) {
    const dir = path.join(repoRoot(), ".data", "mail");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${msg.id}.html`);
    await writeFile(file, msg.html, "utf8");
    console.info(`[mail] to=${msg.to} subject="${msg.subject}" html=${file}`);
    return { messageId: `console-${randomUUID()}` };
  }
}

/** Clearly stubbed: credentials and client libraries arrive later. Selecting one fails loudly, never silently. */
class NotConfiguredProvider implements EmailProvider {
  constructor(readonly name: string) {}
  async send(): Promise<{ messageId: string }> {
    throw new Error(`EMAIL_PROVIDER=${this.name} is not configured yet (credentials and client library pending)`);
  }
}
export const SmtpEmailProvider = () => new NotConfiguredProvider("smtp");
export const SesEmailProvider = () => new NotConfiguredProvider("ses");
export const ResendEmailProvider = () => new NotConfiguredProvider("resend");

export type EmailProviderName = "console" | "smtp" | "ses" | "resend";

export function createEmailProvider(name: EmailProviderName): EmailProvider {
  switch (name) {
    case "console": return new ConsoleEmailProvider();
    case "smtp": return SmtpEmailProvider();
    case "ses": return SesEmailProvider();
    case "resend": return ResendEmailProvider();
    default: throw new Error(`Unknown EMAIL_PROVIDER "${String(name)}"`);
  }
}

let provider: EmailProvider | undefined;
export function getEmailProvider(): EmailProvider {
  return (provider ??= createEmailProvider((process.env.EMAIL_PROVIDER as EmailProviderName | undefined) ?? "console"));
}
/** Tests: swap the provider (undefined resets to the env default). */
export function setEmailProvider(p: EmailProvider | undefined): void {
  provider = p;
}

export const fromAddress = () => process.env.EMAIL_FROM ?? "BizKart <no-reply@bizkart.example>";
