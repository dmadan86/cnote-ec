import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { vi } from "vitest";
import { getCreditPartner, grantCreditConsent, setCreditPartner, setCreditPorts, type CreditPorts, type EscrowFacts, type MockPartner } from "../src/index";

process.env.CREDIT_ENABLED = "1";
delete process.env.CREDIT_PARTNER;
export const uid = () => randomUUID();
export const DAY = 86_400_000;

export const mock = () => getCreditPartner("mock") as MockPartner;

export async function mkPerson(): Promise<string> {
  const p = await prisma.person.create({ data: { email: `credit-${randomUUID()}@example.test` } });
  return p.id;
}
export async function mkActor() {
  return { personId: await mkPerson(), businessId: uid() };
}
export async function consentedActor() {
  const a = await mkActor();
  await grantCreditConsent(a, "test");
  return a;
}

export const facts = (o: Partial<EscrowFacts> & { seller?: string; buyer?: string } = {}): EscrowFacts => ({
  escrowId: o.escrowId ?? uid(), orderId: o.orderId ?? uid(), status: o.status ?? "funded", frozen: o.frozen ?? false, amountPaise: o.amountPaise ?? 10_000_000,
  heldPaise: o.heldPaise ?? 10_000_000, buyerBusinessId: o.buyer ?? o.buyerBusinessId ?? uid(), sellerBusinessId: o.seller ?? o.sellerBusinessId ?? uid(),
});

export interface Fakes { escrows: Map<string, EscrowFacts>; fund: ReturnType<typeof vi.fn>; ports: Partial<CreditPorts> }
/** Good-credit defaults: verified active GST, strong escrow history, no disputes. Override any port. */
export function installPorts(over: Partial<CreditPorts> = {}): Fakes {
  const escrows = new Map<string, EscrowFacts>();
  const fund = vi.fn(async () => true);
  const ports: Partial<CreditPorts> = {
    gst: async () => ({ verified: true, status: "Active", lastCheckedAt: new Date(Date.now() - 10 * DAY), filings: Array.from({ length: 6 }, () => ({ filed: true })) }),
    trust: async () => ({ trustScore: 85, badgeActive: true }),
    escrowHistory: async () => ({ completed: 25, completedPaise: 600_000_000, clean: 25, refunded: 0 }),
    disputes: async () => ({ lost: 0, open: 0 }),
    escrowFacts: async (id) => escrows.get(id) ?? null,
    fundedEscrowsForSeller: async (b) => [...escrows.values()].filter((e) => e.sellerBusinessId === b && e.status === "funded"),
    sellerNetPaise: (a) => Math.floor(a * 0.97),
    fundEscrowFromLender: fund as unknown as CreditPorts["fundEscrowFromLender"],
    ...over,
  };
  setCreditPorts(ports);
  setCreditPartner(null);
  return { escrows, fund, ports };
}
export const resetPorts = () => { setCreditPorts({}); setCreditPartner(null); };

/** Consented seller with a funded escrow, ready to apply for invoice financing. */
export async function sellerWithEscrow(fk: Fakes, o: Partial<EscrowFacts> = {}) {
  const actor = await consentedActor();
  const e = facts({ status: "funded", ...o, sellerBusinessId: actor.businessId });
  fk.escrows.set(e.escrowId, e);
  return { actor, escrow: e };
}
export async function buyerWithEscrow(fk: Fakes, o: Partial<EscrowFacts> = {}) {
  const actor = await consentedActor();
  const e = facts({ status: "awaiting_funding", ...o, buyerBusinessId: actor.businessId });
  fk.escrows.set(e.escrowId, e);
  return { actor, escrow: e };
}
