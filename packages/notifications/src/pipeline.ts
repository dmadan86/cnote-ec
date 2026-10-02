// Observer pipeline: domain event → kinds → recipients → preference/consent gate → Notification row
// (idempotent) → "notification.deliver" jobs for extra channels (email, whatsapp, sms).
import { getJobQueue, redis, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { sendEmail } from "@cnote/email";
import { isChannelEnabled, renderText } from "@cnote/templates";
import { bustUnread } from "./cache";
import { getChannelAdapter } from "./channels";
import { getKind, kindsFor, registerNotificationTemplates } from "./kinds";
import { channelsFor } from "./preferences";
import { prismaDirectory, type Directory } from "./recipients";
import type { ExtraChannel, NotificationApp, NotificationKind, Recipient } from "./types";

export interface NotificationDeliverJob {
  channel: ExtraChannel;
  kind: string;
  eventId: number;
  personId: string;
  businessId: string | null;
  app: NotificationApp;
  vars: Record<string, unknown>;
  href: string;
  /** a digest of folded notifications: the counter to read-and-clear at send time (see emailThrottle) */
  fold?: { key: string; windowKey: string; windowSeconds: number; capKey: string; dailyCap: number };
}

declare module "@cnote/core" {
  interface JobTopics {
    "notification.deliver": NotificationDeliverJob;
  }
}

const EXTRA: ExtraChannel[] = ["email", "whatsapp", "sms"];

const BASE_URL_ENV: Record<NotificationApp, [string, string]> = {
  web: ["APP_URL", "http://localhost:3000"],
  seller: ["SELLER_APP_URL", "http://localhost:3002"],
  admin: ["ADMIN_APP_URL", "http://localhost:3001"],
};

/** Absolute link for emails/messages (relative hrefs are stored in-app). */
export function absoluteUrl(app: NotificationApp, href: string): string {
  const [env, fallback] = BASE_URL_ENV[app];
  return `${(process.env[env] ?? fallback).replace(/\/$/, "")}${href}`;
}

const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

// ---- e-mail flood control (security audit: a sender must not be able to fill an inbox) ---------------------------------
const dayKey = () => new Date().toISOString().slice(0, 10);

/** Counts one email against the recipient's UTC-day cap; false once the cap is exceeded. Fails open if Redis is down (never lose mail to a cache). */
async function underDailyCap(capKey: string, cap: number): Promise<boolean> {
  try {
    const k = `notif:email:day:${capKey}:${dayKey()}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 2 * 86_400);
    return n <= cap;
  } catch {
    return true;
  }
}

/**
 * "send" = deliver now; "folded" = inside the window, counted into a digest (scheduled once per cycle); "capped" = daily cap hit.
 * At most one email per recipient per group (conversation) per window; the digest goes out at the window's end.
 */
async function throttleEmail(kind: NotificationKind, event: DomainEvent, r: Recipient, app: NotificationApp): Promise<"send" | "folded" | "capped"> {
  const cfg = kind.emailThrottle!();
  const group = r.group ?? "-";
  const base = `notif:email:${kind.key}:${r.personId}`;
  const windowKey = `${base}:win:${group}`;
  try {
    const claimed = await redis.set(windowKey, "1", "EX", cfg.windowSeconds, "NX");
    if (claimed !== null) return (await underDailyCap(`${kind.key}:${r.personId}`, cfg.dailyCap)) ? "send" : "capped";
    const foldKey = `${base}:fold:${group}`;
    const n = await redis.incr(foldKey);
    if (n === 1) {
      await redis.expire(foldKey, cfg.windowSeconds * 4 + 3600);
      const ttl = Math.max(1000, await redis.pttl(windowKey));
      const job: NotificationDeliverJob = {
        channel: "email", kind: cfg.digestKind, eventId: event.id, personId: r.personId, businessId: r.businessId ?? null, app, vars: r.vars, href: r.href,
        fold: { key: foldKey, windowKey, windowSeconds: cfg.windowSeconds, capKey: `${kind.key}:${r.personId}`, dailyCap: cfg.dailyCap },
      };
      await getJobQueue().enqueue("notification.deliver", job, { delayMs: ttl + 1000, dedupeKey: `${foldKey}:${Date.now() + ttl}` });
    }
    return "folded";
  } catch (err) {
    console.error("[notifications] email throttle unavailable; sending without coalescing", err);
    return "send";
  }
}

/** Handle one (kind, recipient) pair. Idempotent per (person, kind, event). */
export async function notifyRecipient(kind: NotificationKind, event: DomainEvent, r: Recipient, dir: Directory = prismaDirectory): Promise<{ created: boolean; queued: ExtraChannel[] }> {
  const app = r.app ?? kind.app;
  const enabled = await channelsFor(r.personId, kind.category);
  const vars = { ...r.vars, href: r.href };
  let created = false;

  if (enabled.in_app && (await isChannelEnabled(kind.key, "in_app"))) {
    // in the person's preferred language (ADR-004); templates fall back to English per key
    // a failed lookup must never block the notification: fall back to English
    const locale = (await dir.contact(r.personId).catch(() => null))?.locale;
    const text = await renderText(kind.key, "in_app", vars, { locale });
    try {
      await prisma.notification.create({
        data: {
          personId: r.personId, businessId: r.businessId ?? null, kind: kind.key, app, href: r.href,
          title: text.title ?? kind.name, body: text.body, sourceEventId: BigInt(event.id),
        },
      });
      created = true;
      await bustUnread(r.personId, app);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // redelivery: already notified
    }
  }

  const queued: ExtraChannel[] = [];
  for (const channel of EXTRA) {
    if (!enabled[channel] || !(await isChannelEnabled(kind.key, channel))) continue;
    if (channel === "email" && kind.emailThrottle && (await throttleEmail(kind, event, r, app)) !== "send") continue;
    const job: NotificationDeliverJob = { channel, kind: kind.key, eventId: event.id, personId: r.personId, businessId: r.businessId ?? null, app, vars: r.vars, href: r.href };
    await getJobQueue().enqueue("notification.deliver", job, { dedupeKey: `${kind.key}:${event.id}:${r.personId}:${channel}` });
    queued.push(channel);
  }
  return { created, queued };
}

/** Observer entry point for one domain event. Throws (so the event is redelivered) if any recipient failed. */
export async function notifyForEvent(event: DomainEvent, dir: Directory = prismaDirectory): Promise<void> {
  registerNotificationTemplates();
  const errors: unknown[] = [];
  for (const kind of kindsFor(event.type)) {
    let recipients: Recipient[];
    try {
      recipients = await kind.resolve(event as never, dir);
    } catch (err) {
      errors.push(err);
      continue;
    }
    const seen = new Set<string>();
    for (const r of recipients) {
      if (seen.has(r.personId)) continue;
      seen.add(r.personId);
      try {
        await notifyRecipient(kind, event, r, dir);
      } catch (err) {
        errors.push(err);
      }
    }
  }
  if (errors.length) throw errors[0];
}

/** "notification.deliver" consumer. Re-checks preferences (they may have changed since enqueue). */
export async function deliverJob(job: NotificationDeliverJob, dir: Directory = prismaDirectory): Promise<void> {
  const kind = getKind(job.kind);
  if (!kind) return; // retired kind: drop
  const enabled = await channelsFor(job.personId, kind.category);
  if (!enabled[job.channel] || !(await isChannelEnabled(kind.key, job.channel))) return;
  const contact = await dir.contact(job.personId);
  if (!contact) return; // unknown or erased
  const vars: Record<string, unknown> = { ...job.vars, href: absoluteUrl(job.app, job.href), recipientName: contact.name ?? "" };
  if (job.fold) {
    // digest: read-and-clear the folded count; nothing folded (or already sent) = nothing to send
    const count = Number((await redis.getdel(job.fold.key)) ?? 0);
    if (!count) return;
    if (!(await underDailyCap(job.fold.capKey, job.fold.dailyCap))) return;
    vars.count = count;
    await redis.set(job.fold.windowKey, "1", "EX", job.fold.windowSeconds).catch(() => undefined); // a digest opens the next window
  }

  if (job.channel === "email") {
    if (!contact.email) return;
    await sendEmail({
      template: kind.key,
      to: { email: contact.email, personId: job.personId, name: contact.name },
      vars,
      locale: contact.locale,
      dedupeKey: `${kind.key}:${job.eventId}:${job.personId}${job.fold ? `:digest:${vars.count}:${Date.now()}` : ""}`,
    });
    return;
  }
  if (!contact.phone) return;
  const text = await renderText(kind.key, job.channel, vars, { locale: contact.locale });
  await getChannelAdapter(job.channel).send({ personId: job.personId, to: contact.phone, text: text.body, kind: kind.key });
}
