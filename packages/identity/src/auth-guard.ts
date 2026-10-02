// Brute-force defence layered on top of the fixed-window limits in limits.ts:
//   * progressive per-account backoff: after FREE_FAILURES wrong guesses every further failure doubles the wait
//     (BASE_SECONDS, 2x each, capped at CAP_SECONDS), reset by a success or a password reset. The cap keeps a victim's
//     lockout short, and sign-in from an IP the account already has a session from bypasses it (see knownIp()).
//   * burst detection: counters per 5-minute window, globally and per account; crossing a threshold logs one
//     "auth.failure_burst" security event (ship it to the SIEM / alerting through setSecurityEventSink).
// Keys hold a hash of the subject, never the raw email.
import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { logSecurityEvent } from "@cnote/security";
import { sha256 } from "./tokens";

export const FREE_FAILURES = 5;
export const BASE_SECONDS = 15;
export const CAP_SECONDS = 15 * 60;
const FAIL_WINDOW_SECONDS = 3600;
export const BURST_WINDOW_MS = 5 * 60_000;
export const GLOBAL_BURST_THRESHOLD = 100;
export const ACCOUNT_BURST_THRESHOLD = 10;
const KNOWN_IP_DAYS = 30;

/** MFA already has a fixed 8-per-5-minutes window, so its progressive backoff only starts beyond a full window of misses. */
export const MFA_FREE_FAILURES = 8;

/** Wait imposed after the n-th failure within the hour (0 for the first `free`). */
export const backoffSeconds = (failures: number, free = FREE_FAILURES): number => (failures < free ? 0 : Math.min(BASE_SECONDS * 2 ** Math.min(failures - free, 20), CAP_SECONDS));

const subj = (scope: string, id: string) => sha256(`${scope}:${id}`).slice(0, 32);
const failKey = (scope: string, id: string) => `authfail:n:${subj(scope, id)}`;
const lockKey = (scope: string, id: string) => `authfail:lock:${subj(scope, id)}`;

/** Seconds the account must still wait (0 = free to try). Fails open if Redis is down (the fixed-window limits also fail open). */
export async function backoffRemaining(scope: string, id: string): Promise<number> {
  try {
    // The lock stores its expiry instant (the Redis TTL is only cleanup), so the wait follows the application clock.
    const until = Number(await redis.get(lockKey(scope, id)));
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  } catch {
    return 0;
  }
}

/** True when the person already has (or recently had) a session from this IP: the legitimate owner is not locked out by an attacker's guesses. */
export async function knownIp(personId: string | undefined, ip: string | null | undefined): Promise<boolean> {
  if (!personId || !ip) return false;
  const since = new Date(Date.now() - KNOWN_IP_DAYS * 86_400_000);
  const hit = await prisma.authSession.findFirst({ where: { personId, ip, createdAt: { gt: since } }, select: { id: true } });
  return !!hit;
}

export function throwBackedOff(seconds: number): never {
  throw new DomainError("rate_limited", `Too many failed attempts. Try again in ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`);
}

/** Counts a failure, arms the progressive lock and feeds burst detection. Never throws. */
export async function recordFailure(scope: string, id: string, kind: "auth.signin_failed" | "mfa.failed", free = FREE_FAILURES): Promise<number> {
  try {
    const res = await redis.multi().incr(failKey(scope, id)).expire(failKey(scope, id), FAIL_WINDOW_SECONDS).exec();
    const n = Number(res?.[0]?.[1] ?? 0);
    const wait = backoffSeconds(n, free);
    if (wait > 0) await redis.set(lockKey(scope, id), String(Date.now() + wait * 1000), "EX", wait + 60);
    await noteBurst(kind, subj(scope, id));
    return n;
  } catch (err) {
    console.error("auth failure bookkeeping failed", err);
    return 0;
  }
}

export async function clearFailures(scope: string, id: string): Promise<void> {
  try {
    await redis.del(failKey(scope, id), lockKey(scope, id));
  } catch {
    /* best effort */
  }
}

async function noteBurst(kind: string, accountKey: string): Promise<void> {
  const win = Math.floor(Date.now() / BURST_WINDOW_MS);
  const g = `authfail:burst:${kind}:g:${win}`;
  const a = `authfail:burst:${kind}:a:${accountKey}:${win}`;
  const res = await redis.multi().incr(g).expire(g, 900).incr(a).expire(a, 900).exec();
  const gn = Number(res?.[0]?.[1] ?? 0);
  const an = Number(res?.[2]?.[1] ?? 0);
  // `===` so each window alerts once per scope, not on every further failure.
  if (gn === GLOBAL_BURST_THRESHOLD) logSecurityEvent("auth.failure_burst", { kind, scope: "global", count: gn, windowMinutes: BURST_WINDOW_MS / 60_000 });
  if (an === ACCOUNT_BURST_THRESHOLD) logSecurityEvent("auth.failure_burst", { kind, scope: "account", account: accountKey, count: an, windowMinutes: BURST_WINDOW_MS / 60_000 });
}
