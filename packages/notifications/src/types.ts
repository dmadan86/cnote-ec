// Shared types for @cnote/notifications. Framework-free.
import type { DomainEvent, DomainEventType } from "@cnote/core";
import type { TemplateVariable } from "@cnote/templates";

export const NOTIFICATION_APPS = ["web", "seller", "admin"] as const;
export type NotificationApp = (typeof NOTIFICATION_APPS)[number];

export const CATEGORIES = ["leads", "messages", "reviews", "listings", "billing", "security", "marketing"] as const;
export type NotificationCategory = (typeof CATEGORIES)[number];

export const CHANNELS = ["in_app", "email", "whatsapp", "sms"] as const;
export type NotificationChannel = (typeof CHANNELS)[number];
/** Channels delivered through the "notification.deliver" job (in_app is written inline). */
export type ExtraChannel = Exclude<NotificationChannel, "in_app">;

export interface Recipient {
  personId: string;
  businessId?: string;
  /** overrides the kind's app (e.g. MessageSent goes to web or seller depending on the side) */
  app?: NotificationApp;
  /** template variables for this recipient */
  vars: Record<string, unknown>;
  /** app-relative path, e.g. "/leads" */
  href: string;
}

export interface KindContent {
  subject?: string;
  body: string;
}

export interface NotificationKind<E extends DomainEventType = DomainEventType> {
  /** stable key, also the template key: "lead.matched" */
  key: string;
  name: string;
  description: string;
  category: NotificationCategory;
  app: NotificationApp;
  /** the domain event this kind observes (several kinds may observe one event) */
  event: E;
  variables: TemplateVariable[];
  defaults: { in_app: KindContent; email?: KindContent };
  resolve(event: DomainEvent<E>, dir: import("./recipients").Directory): Promise<Recipient[]>;
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  app: NotificationApp;
  businessId: string | null;
  read: boolean;
  createdAt: string;
}

/** person × category × channel matrix (defaults merged). */
export type PreferenceMatrix = Record<NotificationCategory, Record<NotificationChannel, boolean>>;
