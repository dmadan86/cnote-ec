// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
// The consent ledger is NEVER purged: it is the legal record of what a person agreed to (append-only, ADR-007).
import { prisma } from "@cnote/db";

/** Deletes auth sessions that were revoked or expired before `before`. `dryRun` only counts. */
export async function purgeExpiredAuthSessions(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { OR: [{ revokedAt: { lt: before } }, { expiresAt: { lt: before } }] };
  if (opts.dryRun) return prisma.authSession.count({ where });
  return (await prisma.authSession.deleteMany({ where })).count;
}

/** Deletes residual session rows (IP, user agent) of persons erased before `before`. `dryRun` only counts. */
export async function purgeErasedPersonResiduals(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { person: { erasedAt: { lt: before } } };
  if (opts.dryRun) return prisma.authSession.count({ where });
  return (await prisma.authSession.deleteMany({ where })).count;
}
