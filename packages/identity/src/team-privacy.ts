// DPDP for the buyer team module: invitations hold an email address (the invitee's), so they are exported, erased and aged out.
import { prisma } from "@cnote/db";
import { normaliseEmail } from "./password";

/** Invitations the person sent, and any addressed to their email, for the data export. */
export async function exportTeamData(personId: string): Promise<Record<string, unknown>> {
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { email: true } });
  const [sent, received] = await Promise.all([
    prisma.businessInvite.findMany({ where: { invitedByPersonId: personId }, orderBy: { createdAt: "asc" }, take: 500 }),
    p?.email ? prisma.businessInvite.findMany({ where: { email: normaliseEmail(p.email) }, orderBy: { createdAt: "asc" }, take: 100 }) : Promise.resolve([]),
  ]);
  const view = (i: (typeof sent)[number]) => ({ businessId: i.businessId, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt, revokedAt: i.revokedAt });
  return { invitationsSent: sent.map(view), invitationsReceived: received.map(view) };
}

type InviteDeleter = Pick<typeof prisma, "businessInvite">;

/** Erasure: invitations the person sent or received go (they exist only to onboard a person). Call BEFORE the email is tombstoned. Idempotent. */
export async function eraseTeamData(db: InviteDeleter, personId: string): Promise<void> {
  const p = await prisma.person.findUnique({ where: { id: personId }, select: { email: true } });
  await db.businessInvite.deleteMany({
    where: { OR: [{ invitedByPersonId: personId }, { acceptedByPersonId: personId }, ...(p?.email ? [{ email: normaliseEmail(p.email) }] : [])] },
  });
}

/** Storage limitation: used, revoked and long-expired invitations (they hold an email address) go after `before`. */
export async function purgeOldInvites(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { OR: [{ acceptedAt: { lt: before } }, { revokedAt: { lt: before } }, { expiresAt: { lt: before } }] };
  if (opts.dryRun) return prisma.businessInvite.count({ where });
  return (await prisma.businessInvite.deleteMany({ where })).count;
}
