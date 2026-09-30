import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { createEscrowForOrder, getEscrowPartner, MockPartner, simulateMockFunding } from "../src/index";

process.env.ESCROW_ENABLED = "1";
delete process.env.ESCROW_PARTNER;
export const uid = () => randomUUID();
export const DAY = 86_400_000;
const created = { business: [] as string[], order: [] as string[] };

export const mock = () => getEscrowPartner("mock") as MockPartner;

export async function mkBusiness(seller = false) {
  const b = await prisma.business.create({ data: { name: `Escrow ${randomUUID().slice(0, 8)}`, isSeller: seller } });
  created.business.push(b.id);
  return b.id;
}
export const actorOf = (businessId: string) => ({ personId: randomUUID(), businessId });

export async function mkOrder(o: { total?: number | null; status?: "recorded" | "confirmed" | "dispatched" | "delivered" | "completed" | "cancelled"; buyer?: string; seller?: string } = {}) {
  const buyer = o.buyer ?? (await mkBusiness());
  const seller = o.seller ?? (await mkBusiness(true));
  const order = await prisma.order.create({
    data: {
      matchId: randomUUID(), enquiryId: randomUUID(), buyerBusinessId: buyer, sellerBusinessId: seller, status: o.status ?? "confirmed",
      totalPaise: o.total === null ? null : BigInt(o.total ?? 1_000_000), quantity: 10, unit: "kg", pricePaise: 100_000n,
    },
  });
  created.order.push(order.id);
  return { orderId: order.id, buyer, seller, buyerActor: actorOf(buyer), sellerActor: actorOf(seller) };
}
export const setOrder = (orderId: string, status: "recorded" | "confirmed" | "dispatched" | "delivered" | "completed" | "cancelled") =>
  prisma.order.update({ where: { id: orderId }, data: { status } });

/** Order + escrow opened + funded through the (mock) webhook path. */
export async function fundedEscrow(o: { total?: number; status?: "confirmed" | "dispatched" | "delivered" } = {}) {
  const ctx = await mkOrder({ total: o.total, status: o.status ?? "confirmed" });
  const view = await createEscrowForOrder(ctx.buyerActor, ctx.orderId);
  await simulateMockFunding(ctx.buyerActor, ctx.orderId);
  return { ...ctx, escrowId: view.id };
}

export async function ledgerFor(escrowId: string) {
  const lines = await prisma.ledgerLine.findMany({ where: { journal: { escrowId } }, include: { account: true, journal: true } });
  const debit = lines.reduce((a, l) => a + Number(l.debitPaise), 0);
  const credit = lines.reduce((a, l) => a + Number(l.creditPaise), 0);
  const bal = (prefix: string) => lines.filter((l) => l.account.code.startsWith(prefix)).reduce((a, l) => a + Number(l.creditPaise) - Number(l.debitPaise), 0);
  return { lines, debit, credit, escrowHeld: bal("buyer_escrow:"), sellerPayable: bal("seller_payable:"), refundPayable: bal("buyer_refund_payable:"), fee: bal("platform_fee"), gst: bal("gst_output"), nodal: 0 - bal("partner_nodal") };
}

export async function eventsOf(type: string, aggregateId: string) {
  return prisma.domainEvent.findMany({ where: { type, aggregateId }, orderBy: { id: "asc" } });
}

export async function cleanup() {
  await prisma.order.deleteMany({ where: { id: { in: created.order } } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: { in: created.business } } }).catch(() => {});
}
