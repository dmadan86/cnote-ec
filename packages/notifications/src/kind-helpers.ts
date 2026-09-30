// Small helpers shared by the kind registries (kinds.ts, kinds-phase23.ts). Kept apart to avoid an import cycle.
import type { DomainEventType } from "@cnote/core";
import type { TemplateVariable } from "@cnote/templates";
import type { Directory } from "./recipients";
import type { NotificationKind, Recipient } from "./types";

export const v = (name: string, description: string, example: string): TemplateVariable => ({ name, description, example });
export const RECIPIENT_NAME = v("recipientName", "Recipient's name (may be empty)", "Asha");
export const HREF = v("href", "Absolute link to the relevant page", "https://example.com/leads");

/** Paise → "₹1,23,456.5" (Indian grouping). */
export const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export async function membersOf(dir: Directory, businessId: string, opts?: { ownersOnly?: boolean }) {
  return dir.businessMembers(businessId, opts);
}

export function fan(personIds: string[], base: Omit<Recipient, "personId">): Recipient[] {
  return [...new Set(personIds)].map((personId) => ({ ...base, personId }));
}

export function kind<E extends DomainEventType>(k: NotificationKind<E>): NotificationKind {
  return k as unknown as NotificationKind;
}
