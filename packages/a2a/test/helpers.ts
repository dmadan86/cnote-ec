import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";

export const tag = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
export interface Party { personId: string; businessId: string }

export const world = { bizIds: [] as string[], personIds: [] as string[], enquiryIds: [] as string[], listings: [] as any[] };

export async function party(name: string): Promise<Party> {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, city: "Pune", verificationTier: 1 } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  world.personIds.push(p.id);
  world.bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

export function addListing(sellerBusinessId: string, over: Record<string, unknown> = {}) {
  const l = {
    id: randomUUID(), sellerBusinessId, category: { id: randomUUID(), slug: "boxes", name: "Boxes" }, title: "Corrugated boxes 3 ply", description: "3 ply corrugated shipping boxes",
    attributes: {}, pricePaise: 5000, priceUnit: "pcs", moq: 50, moqUnit: "pcs", hsn: null, language: "en", imageUrls: [], aiGenerated: false, status: "published",
    moderationStatus: "approved", moderationReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
  world.listings.push(l);
  return l as { id: string; title: string };
}

export async function grant(businessId: string, credits = 3) {
  await prisma.creditLedgerEntry.create({ data: { businessId, delta: credits, reason: "grant", refType: "grant", refId: tag, expiresAt: new Date(Date.now() + 90 * 86_400_000) } });
}

/** An enquiry + match created directly so tests do not depend on matching. */
export async function matchFor(buyer: Party, seller: Party, over: { status?: "offered" | "accepted"; quantity?: number } = {}) {
  const e = await prisma.enquiry.create({
    data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes for shipping garments", quantity: over.quantity ?? 100, quantityUnit: "pcs", deliveryCity: "Pune", status: "matched" },
  });
  world.enquiryIds.push(e.id);
  const status = over.status ?? "accepted";
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status, respondBy: new Date(Date.now() + 7_200_000), respondedAt: status === "accepted" ? new Date() : null } });
  const c = status === "accepted" ? await prisma.conversation.create({ data: { matchId: m.id } }) : null;
  return { enquiryId: e.id, matchId: m.id, conversationId: c?.id ?? null };
}

export async function cleanup() {
  const ids = world.bizIds;
  const negs = (await prisma.agentNegotiation.findMany({ where: { OR: [{ buyerBusinessId: { in: ids } }, { sellerBusinessId: { in: ids } }] }, select: { id: true } })).map((n) => n.id);
  const mandates = (await prisma.agentMandate.findMany({ where: { businessId: { in: ids } }, select: { id: true } })).map((m) => m.id);
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: world.enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  const matches = (await prisma.match.findMany({ where: { enquiryId: { in: world.enquiryIds } }, select: { id: true } })).map((m) => m.id);
  const orders = (await prisma.order.findMany({ where: { enquiryId: { in: world.enquiryIds } }, select: { id: true } })).map((o) => o.id);
  await prisma.agentMessage.deleteMany({ where: { negotiationId: { in: negs } } });
  await prisma.agentActivity.deleteMany({ where: { principalBusinessId: { in: ids } } });
  await prisma.agentAnomaly.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.agentSuspension.deleteMany({ where: { OR: [{ businessId: { in: ids } }, { targetId: { in: [...ids, ...mandates] } }] } });
  await prisma.agentNegotiation.deleteMany({ where: { id: { in: negs } } });
  await prisma.agentRun.deleteMany({ where: { mandateId: { in: mandates } } });
  await prisma.agentMandateChange.deleteMany({ where: { mandateId: { in: mandates } } });
  await prisma.agentMandate.deleteMany({ where: { id: { in: mandates } } });
  await prisma.sellerPriceBook.deleteMany({ where: { sellerBusinessId: { in: ids } } });
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: world.enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: world.enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${[...world.enquiryIds, ...convos, ...matches, ...orders, ...negs, ...mandates, ...ids]}) OR payload->>'sellerBusinessId' = ANY(${ids}) OR payload->>'buyerBusinessId' = ANY(${ids}) OR payload->>'businessId' = ANY(${ids})`;
  await prisma.businessMember.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: ids } } });
  await prisma.person.deleteMany({ where: { id: { in: world.personIds } } });
}

export async function events(type: string, aggregateId: string) {
  return prisma.$queryRaw<{ payload: any }[]>`SELECT payload FROM domain_events WHERE type = ${type} AND aggregate_id = ${aggregateId}`;
}

export const validUntil = (days = 5) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
