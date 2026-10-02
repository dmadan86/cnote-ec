// Small helpers shared by the kind registries (kinds.ts, kinds-phase23.ts). Kept apart to avoid an import cycle.
import type { DomainEventType } from "@cnote/core";
import type { TemplateVariable } from "@cnote/templates";
import type { Directory } from "./recipients";
import type { NotificationKind, Recipient } from "./types";

/** Positive integer from the environment, else the default (read lazily so operators can tune without a deploy of code). */
export function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

export const v = (name: string, description: string, example: string): TemplateVariable => ({ name, description, example });
export const RECIPIENT_NAME = v("recipientName", "Recipient's name (may be empty)", "Asha");
export const HREF = v("href", "Absolute link to the relevant page", "https://example.com/leads");

/** Paise → "₹1,23,456.5" (Indian grouping). */
export const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export async function membersOf(dir: Directory, businessId: string, opts?: { ownersOnly?: boolean }) {
  return dir.businessMembers(businessId, opts);
}

/**
 * Sender-controlled display text (a business name) that ends up in an email SUBJECT: strip CR/LF and other control characters
 * (header injection) and cap the length (security audit).
 */
export function cleanName(name: string | null | undefined, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const flat = (name ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function fan(personIds: string[], base: Omit<Recipient, "personId">): Recipient[] {
  return [...new Set(personIds)].map((personId) => ({ ...base, personId }));
}

export function kind<E extends DomainEventType>(k: NotificationKind<E>): NotificationKind {
  return k as unknown as NotificationKind;
}
