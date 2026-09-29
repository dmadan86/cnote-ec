// @cnote/templates — admin-editable email/notification content (DB is the source of truth).
// Code owns template KEYS + their variables (registry); staff own the words, layout and images.
// PUBLIC CONTRACT — @cnote/email, @cnote/notifications and apps/admin depend on these. Extend, don't break.

export type TemplateChannel = "email" | "in_app" | "sms" | "whatsapp";
export type TemplateCategory = "transactional" | "security" | "marketing";

export interface TemplateVariable {
  name: string; // "buyerName" → {{buyerName}}
  description: string;
  example: string;
  required?: boolean;
}

export interface TemplateDefinition {
  key: string; // "auth.password_reset", "lead.matched", …
  name: string;
  description: string;
  category: TemplateCategory;
  channels: TemplateChannel[];
  variables: TemplateVariable[];
  /** Seed content used to create the first published version (and as last-resort fallback). */
  defaults: Partial<Record<TemplateChannel, { subject?: string; preheader?: string; body: string }>>;
}

export interface RenderedEmail {
  subject: string;
  preheader: string | null;
  /** full HTML document: layout header + body + footer, CSS inlined, variables escaped */
  html: string;
  text: string;
  templateVersionId: string | null; // null = code fallback was used
  layoutVersionId: string | null;
}

export interface RenderedText {
  title: string | null;
  body: string;
  templateVersionId: string | null;
}

/** Register template definitions (each module registers its own keys at import time). */
export function defineTemplates(defs: TemplateDefinition[]): void {
  void defs;
  throw new Error("not implemented");
}
export function listTemplateDefinitions(): TemplateDefinition[] {
  throw new Error("not implemented");
}

/**
 * Render the PUBLISHED email version for key+locale (fallback: "en", then code defaults).
 * Throws DomainError("validation") when a required variable is missing. Cached in Redis by
 * published version id (invalidated on publish).
 */
export async function renderEmail(key: string, vars: Record<string, unknown>, opts?: { locale?: string }): Promise<RenderedEmail> {
  void key; void vars; void opts;
  throw new Error("not implemented");
}
/** Render in_app / sms / whatsapp text. */
export async function renderText(key: string, channel: Exclude<TemplateChannel, "email">, vars: Record<string, unknown>, opts?: { locale?: string }): Promise<RenderedText> {
  void key; void channel; void vars; void opts;
  throw new Error("not implemented");
}
/** Whether a published, enabled template exists for this key+channel (else the channel is skipped). */
export async function isChannelEnabled(key: string, channel: TemplateChannel, locale?: string): Promise<boolean> {
  void key; void channel; void locale;
  throw new Error("not implemented");
}
