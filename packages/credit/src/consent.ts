// Purpose-scoped consent `credit_underwriting` (DPDP, ADR-010). The ledger is identity's (keyed by person); this module keeps a
// business<->person link so worker-side recomputes can find who consented. Withdrawal stops future scoring and partner sharing.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hasConsent, setConsent } from "@cnote/identity";
import { assertCreditEnabled } from "./config";
import type { Actor } from "./types";

const PURPOSE = "credit_underwriting" as const;

/** True when at least one person linked to the business has an active `credit_underwriting` consent in the identity ledger. */
export async function hasActiveCreditConsent(businessId: string): Promise<boolean> {
  const links = await prisma.creditConsentLink.findMany({ where: { businessId, withdrawnAt: null }, select: { personId: true } });
  for (const l of links) if (await hasConsent(l.personId, PURPOSE)) return true;
  return false;
}

/** Consent of this specific person (the one acting) for this business. */
export async function actorHasCreditConsent(actor: Actor): Promise<boolean> {
  const link = await prisma.creditConsentLink.findUnique({ where: { businessId_personId: { businessId: actor.businessId, personId: actor.personId } } });
  return !!link && link.withdrawnAt === null && (await hasConsent(actor.personId, PURPOSE));
}

export async function grantCreditConsent(actor: Actor, source = "seller_portal"): Promise<void> {
  assertCreditEnabled();
  await setConsent(actor.personId, PURPOSE, true, source);
  await prisma.creditConsentLink.upsert({
    where: { businessId_personId: { businessId: actor.businessId, personId: actor.personId } },
    create: { businessId: actor.businessId, personId: actor.personId },
    update: { withdrawnAt: null, grantedAt: new Date() },
  });
}

/** Withdraw: no new scores, no further sharing; un-accepted applications are cancelled and their open offers withdrawn. */
export async function withdrawCreditConsent(actor: Actor, source = "seller_portal"): Promise<void> {
  if (!actor.personId) throw new DomainError("validation", "Missing person.");
  await setConsent(actor.personId, PURPOSE, false, source);
  await prisma.$transaction(async (tx) => {
    await tx.creditConsentLink.updateMany({ where: { businessId: actor.businessId, personId: actor.personId, withdrawnAt: null }, data: { withdrawnAt: new Date() } });
    const remaining = await tx.creditConsentLink.count({ where: { businessId: actor.businessId, withdrawnAt: null } });
    if (remaining > 0) return;
    const apps = await tx.creditApplication.findMany({ where: { businessId: actor.businessId, status: { in: ["submitted", "offered"] } }, select: { id: true } });
    const ids = apps.map((a) => a.id);
    await tx.creditOffer.updateMany({ where: { applicationId: { in: ids }, status: "open" }, data: { status: "withdrawn" } });
    await tx.creditApplication.updateMany({ where: { id: { in: ids } }, data: { status: "cancelled", reason: "consent_withdrawn", closedAt: new Date() } });
  });
}
