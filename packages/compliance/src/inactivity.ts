// Inactivity erasure with a 48-hour notice (DPDP Rules 2025, r.8 and the Third Schedule).
//
// Where it applies: a Data Fiduciary in the Third Schedule classes (e-commerce entities above the registered-user threshold, online
// gaming intermediaries, social media intermediaries) must erase a data principal's personal data once the principal has neither
// approached it for the specified purpose nor exercised their rights for the prescribed period (3 years for e-commerce), and must
// inform the principal AT LEAST 48 HOURS BEFORE the period completes, so that they can log in or get in touch to stop the erasure.
// Source: DPDP Rules 2025 (G.S.R. 846(E), 13 Nov 2025), r.8(2) with the Third Schedule; verify the gazetted text and whether the
// platform crosses the user threshold before enabling. Hence the gate: INACTIVITY_ERASURE_ENABLED defaults OFF.
//
// How it works (a RetentionPolicy, `identity.inactive_accounts_erasure`, run by the daily retention tick):
//   1. NOTICE.  A buyer-side personal account whose last activity is older than (window - notice period) gets an
//      `InactivityErasureNotice` row and an `InactivityErasureNoticeSent` event in one transaction. @cnote/notifications observes the
//      event and e-mails the DB template `account.inactivity_erasure_notice` (en + hi seed). `eraseAfter` = now + notice period, and the
//      notice period is never below 48 hours (INACTIVITY_NOTICE_HOURS, default 168 = 7 days).
//   2. ERASE.   Only after `eraseAfter`, and only if the person has NOT been active since the notice (sign-in, session refresh or API key
//      use) and is still eligible, the account is erased through identity's `erasePerson` (the same path as the person's own erasure).
//      Otherwise the notice is cancelled with the reason. Coming back always wins.
// Never candidates: staff, anyone in a seller business (tax-invoice and trust records outrank erasure, see erasePerson), people with no
// e-mail address (we could not give notice, so we do not erase), and anyone with a live session.
import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hasApiKeyActivitySince } from "@cnote/developer";
import { erasePerson, getLastActiveAt, isInactivityEligible, listInactiveAccounts } from "@cnote/identity";
import { numFromEnv } from "./config";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** DPDP Rules 2025 r.8(2): the notice must precede erasure by at least this long. Not configurable below it. */
export const MIN_NOTICE_HOURS = 48;
export const DEFAULT_NOTICE_HOURS = 168;
const BATCH = 200;

export const inactivityErasureEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.INACTIVITY_ERASURE_ENABLED === "true";

/** Notice period in ms: INACTIVITY_NOTICE_HOURS, clamped UP to the statutory 48 hours. */
export const noticePeriodMs = (env: NodeJS.ProcessEnv = process.env): number => Math.max(MIN_NOTICE_HOURS, numFromEnv(env.INACTIVITY_NOTICE_HOURS, DEFAULT_NOTICE_HOURS)) * HOUR;

export interface InactivityRunResult {
  noticed: number;
  erased: number;
  cancelled: number;
}

/** Step 1: send notices to accounts that reach the inactivity window within the notice period. Returns how many were (or would be) sent. */
export async function sendInactivityNotices(o: { now: Date; windowMs: number; dryRun?: boolean; env?: NodeJS.ProcessEnv }): Promise<number> {
  const { now, windowMs, dryRun = false } = o;
  const notice = noticePeriodMs(o.env);
  // The erasure date is lastActive + window, so the notice goes out once lastActive <= now - (window - notice).
  const inactiveBefore = new Date(now.getTime() - Math.max(windowMs - notice, 0));
  const candidates = await listInactiveAccounts(inactiveBefore, BATCH);
  let n = 0;
  for (const c of candidates) {
    // A person already noticed within this window (pending, or cancelled because they came back by API only) is not noticed again.
    const prior = await prisma.inactivityErasureNotice.count({ where: { personId: c.personId, noticedAt: { gt: new Date(now.getTime() - windowMs) } } });
    if (prior > 0) continue;
    if (await hasApiKeyActivitySince(c.personId, inactiveBefore)) continue;
    n++;
    if (dryRun) continue;
    const eraseAfter = new Date(Math.max(c.lastActiveAt.getTime() + windowMs, now.getTime() + notice));
    await prisma.$transaction(async (tx) => {
      const row = await tx.inactivityErasureNotice.create({ data: { personId: c.personId, lastActiveAt: c.lastActiveAt, noticedAt: now, eraseAfter } });
      await emit(tx, "InactivityErasureNoticeSent", { type: "Person", id: c.personId }, { personId: c.personId, noticeId: row.id, eraseAfter: eraseAfter.toISOString(), lastActiveAt: c.lastActiveAt.toISOString() });
    });
  }
  return n;
}

/** Step 2: erase (or cancel) the notices whose waiting period is over. Returns { erased, cancelled } (dry run: what would happen). */
export async function executeInactivityErasures(o: { now: Date; dryRun?: boolean }): Promise<{ erased: number; cancelled: number }> {
  const { now, dryRun = false } = o;
  const due = await prisma.inactivityErasureNotice.findMany({ where: { status: "pending", eraseAfter: { lte: now } }, orderBy: { eraseAfter: "asc" }, take: BATCH });
  let erased = 0;
  let cancelled = 0;
  for (const n of due) {
    const cancel = async (resolution: string) => {
      cancelled++;
      if (!dryRun) await prisma.inactivityErasureNotice.update({ where: { id: n.id }, data: { status: "cancelled", resolution, resolvedAt: now } });
    };
    // Never erase on less than the statutory notice, whatever the row says (defence in depth against a bad manual edit).
    if (n.eraseAfter.getTime() - n.noticedAt.getTime() < MIN_NOTICE_HOURS * HOUR) {
      await cancel("notice_period_too_short");
      continue;
    }
    const lastActive = await getLastActiveAt(n.personId);
    if (!lastActive) {
      await cancel("already_erased");
      continue;
    }
    if (lastActive.getTime() > n.noticedAt.getTime()) {
      await cancel("activity_since_notice");
      continue;
    }
    if (await hasApiKeyActivitySince(n.personId, n.noticedAt)) {
      await cancel("api_activity_since_notice");
      continue;
    }
    if (!(await isInactivityEligible(n.personId))) {
      await cancel("no_longer_eligible");
      continue;
    }
    erased++;
    if (dryRun) continue;
    await erasePerson(n.personId);
    await prisma.inactivityErasureNotice.update({ where: { id: n.id }, data: { status: "erased", resolution: "erased", resolvedAt: now } });
  }
  return { erased, cancelled };
}

/**
 * The retention policy body: notices first, then erasures that were noticed in an EARLIER run (a notice created now has
 * `eraseAfter` >= 48h away, so it can never be erased in the same run). Gated by INACTIVITY_ERASURE_ENABLED; a dry run still reports
 * the numbers when the flag is off, but nothing is ever sent or erased unless the flag is on.
 */
export async function runInactivityErasure(o: { now: Date; windowMs: number; dryRun?: boolean; env?: NodeJS.ProcessEnv }): Promise<InactivityRunResult> {
  const env = o.env ?? process.env;
  const enabled = inactivityErasureEnabled(env);
  if (!enabled && !o.dryRun) return { noticed: 0, erased: 0, cancelled: 0 };
  const dryRun = o.dryRun || !enabled;
  const { erased, cancelled } = await executeInactivityErasures({ now: o.now, dryRun });
  const noticed = await sendInactivityNotices({ now: o.now, windowMs: o.windowMs, dryRun, env });
  return { noticed, erased, cancelled };
}

export const INACTIVITY_DEFAULT_DAYS = 1095; // 3 years: Third Schedule, e-commerce entities
export const inactivityWindowMs = (days: number) => days * DAY;
