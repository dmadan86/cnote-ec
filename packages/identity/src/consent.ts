import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { CONSENT_PURPOSES, type ConsentPurpose } from "./types";

/** Append-only ledger (ADR-010): state = latest row per purpose. */
export async function setConsent(personId: string, purpose: ConsentPurpose, granted: boolean, source: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.consent.create({ data: { personId, purpose, granted, source } });
    await emit(tx, "ConsentChanged", { type: "Person", id: personId }, { personId, purpose, granted });
  });
}

export async function hasConsent(personId: string, purpose: ConsentPurpose): Promise<boolean> {
  const row = await prisma.consent.findFirst({ where: { personId, purpose }, orderBy: { createdAt: "desc" }, select: { granted: true } });
  return row?.granted ?? false;
}

export async function getConsents(personId: string): Promise<Record<ConsentPurpose, boolean>> {
  const rows = await prisma.consent.findMany({ where: { personId }, orderBy: { createdAt: "asc" }, select: { purpose: true, granted: true } });
  const out = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, false])) as Record<ConsentPurpose, boolean>;
  for (const r of rows) out[r.purpose] = r.granted; // ascending order: last write wins
  return out;
}
