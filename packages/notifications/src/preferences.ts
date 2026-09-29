// Per-person channel preferences (NotificationPreference; a missing row = category default).
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getConsents } from "@cnote/identity";
import { CATEGORIES, CHANNELS, type NotificationCategory, type NotificationChannel, type PreferenceMatrix } from "./types";

export const CATEGORY_META: Record<NotificationCategory, { label: string; description: string }> = {
  leads: { label: "Leads and requirements", description: "New leads, accepted requirements and review of your enquiries." },
  messages: { label: "Messages and quotes", description: "Conversation messages and quotes from the other party." },
  reviews: { label: "Reviews and questions", description: "Moderation results and new reviews on your products." },
  listings: { label: "Listings and verification", description: "Listing and image moderation, verification and trust updates." },
  billing: { label: "Billing and credits", description: "Credits, plans and payments." },
  security: { label: "Security", description: "Sign-in and account security alerts." },
  marketing: { label: "Offers and product news", description: "Tips, offers and announcements." },
};

export const CHANNEL_LABEL: Record<NotificationChannel, string> = { in_app: "In-app", email: "Email", whatsapp: "WhatsApp", sms: "SMS" };

const DEFAULT_EMAIL: Record<NotificationCategory, boolean> = {
  leads: true, messages: true, security: true, billing: true, reviews: false, listings: false, marketing: false,
};

export function defaultPreference(category: NotificationCategory): Record<NotificationChannel, boolean> {
  return { in_app: true, email: DEFAULT_EMAIL[category], whatsapp: false, sms: false };
}

/**
 * Why a toggle cannot be changed: "required" (security in-app/email always on) or "consent"
 * (marketing outside the app needs the identity "marketing" consent).
 */
export function channelLock(category: NotificationCategory, channel: NotificationChannel): "required" | "consent" | null {
  if (category === "security" && (channel === "in_app" || channel === "email")) return "required";
  if (category === "marketing" && channel !== "in_app") return "consent";
  return null;
}

/** Apply hard rules on top of the stored preference (security always on, marketing needs consent). */
export function effectiveChannels(category: NotificationCategory, stored: Record<NotificationChannel, boolean>, marketingConsent: boolean): Record<NotificationChannel, boolean> {
  const out = { ...stored };
  if (category === "security") { out.in_app = true; out.email = true; }
  if (category === "marketing" && !marketingConsent) { out.email = false; out.whatsapp = false; out.sms = false; }
  return out;
}

const fromRow = (r: { inApp: boolean; email: boolean; whatsapp: boolean; sms: boolean }): Record<NotificationChannel, boolean> => ({
  in_app: r.inApp, email: r.email, whatsapp: r.whatsapp, sms: r.sms,
});

/** Stored preferences merged with defaults (raw: hard rules are applied by effectiveChannels). */
export async function getPreferences(personId: string): Promise<PreferenceMatrix> {
  const rows = await prisma.notificationPreference.findMany({ where: { personId } });
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, defaultPreference(c)])) as PreferenceMatrix;
  for (const r of rows) if ((CATEGORIES as readonly string[]).includes(r.category)) out[r.category as NotificationCategory] = fromRow(r);
  return out;
}

export async function setPreference(personId: string, category: NotificationCategory, channel: NotificationChannel, enabled: boolean): Promise<void> {
  if (!CATEGORIES.includes(category) || !CHANNELS.includes(channel)) throw new DomainError("validation", "Unknown notification category or channel.");
  if (channelLock(category, channel) === "required" && !enabled) throw new DomainError("validation", "Security notifications cannot be turned off.");
  if (channelLock(category, channel) === "consent" && enabled && !(await getConsents(personId)).marketing) {
    throw new DomainError("validation", "Allow marketing communication in your privacy settings first.");
  }
  const cur = (await getPreferences(personId))[category];
  const next = { ...cur, [channel]: enabled };
  const data = { inApp: next.in_app, email: next.email, whatsapp: next.whatsapp, sms: next.sms };
  await prisma.notificationPreference.upsert({ where: { personId_category: { personId, category } }, create: { personId, category, ...data }, update: data });
}

/** Preferences + consent for one person, as used by the pipeline. */
export async function channelsFor(personId: string, category: NotificationCategory): Promise<Record<NotificationChannel, boolean>> {
  const [prefs, consents] = await Promise.all([getPreferences(personId), category === "marketing" ? getConsents(personId) : Promise.resolve(null)]);
  return effectiveChannels(category, prefs[category], consents?.marketing ?? false);
}
