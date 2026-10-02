import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { CONSENT_PURPOSES, type ConsentPurpose } from "./types";

export interface ConsentLedgerState {
  granted: boolean;
  /** when the latest ledger row for the purpose was written */
  at: Date;
}

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

/** Latest ledger row per requested purpose (null = never recorded), with its timestamp, so callers can compare recency. */
export async function getConsentStates<P extends ConsentPurpose>(personId: string, purposes: readonly P[]): Promise<Record<P, ConsentLedgerState | null>> {
  const rows = await prisma.consent.findMany({ where: { personId, purpose: { in: [...purposes] } }, orderBy: { createdAt: "asc" }, select: { purpose: true, granted: true, createdAt: true } });
  const out = Object.fromEntries(purposes.map((p) => [p, null])) as Record<P, ConsentLedgerState | null>;
  for (const r of rows) out[r.purpose as P] = { granted: r.granted, at: r.createdAt };
  return out;
}

export async function getConsents(personId: string): Promise<Record<ConsentPurpose, boolean>> {
  const rows = await prisma.consent.findMany({ where: { personId }, orderBy: { createdAt: "asc" }, select: { purpose: true, granted: true } });
  const out = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, false])) as Record<ConsentPurpose, boolean>;
  for (const r of rows) out[r.purpose] = r.granted; // ascending order: last write wins
  return out;
}
