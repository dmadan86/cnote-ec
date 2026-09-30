import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";

export const tag = `neg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
export interface Party { personId: string; businessId: string }

export const world = {
  bizIds: [] as string[],
  personIds: [] as string[],
  enquiryIds: [] as string[],
  listings: [] as any[],
};

export async function party(name: string, opts: { tier?: number } = {}): Promise<Party> {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, city: "Pune", verificationTier: opts.tier ?? 1 } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  world.personIds.push(p.id);
  world.bizIds.push(b.id);
  return { personId: p.id, businessId: b.id };
}

export function addListing(sellerBusinessId: string, over: Record<string, unknown> = {}) {
  const l = {
    id: randomUUID(), sellerBusinessId, category: { id: randomUUID(), slug: "boxes", name: "Boxes" }, title: "Corrugated boxes 3 ply", description: "3 ply corrugated shipping boxes",
    attributes: {}, pricePaise: 5000, priceUnit: "pcs", moq: 100, moqUnit: "pcs", hsn: null, language: "en", imageUrls: [], aiGenerated: false, status: "published",
    moderationStatus: "approved", moderationReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
  world.listings.push(l);
  return l as { id: string; title: string };
}

/** An accepted lead (match + conversation) created directly, so tests don't depend on matching/billing. */
export async function acceptedLead(buyer: Party, seller: Party, over: { quantity?: number | null; targetPricePaise?: number | null; neededBy?: string | null; title?: string; status?: "accepted" | "offered" } = {}) {
  const e = await prisma.enquiry.create({
    data: {
      buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: over.title ?? "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes for shipping garments",
      quantity: over.quantity === undefined ? 600 : over.quantity, quantityUnit: "pcs", targetPricePaise: over.targetPricePaise == null ? null : BigInt(over.targetPricePaise),
      deliveryCity: "Pune", neededBy: over.neededBy ? new Date(over.neededBy) : null, status: "matched",
    },
  });
  world.enquiryIds.push(e.id);
  const status = over.status ?? "accepted";
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status, respondBy: new Date(Date.now() + 7_200_000), respondedAt: new Date() } });
  const c = status === "accepted" ? await prisma.conversation.create({ data: { matchId: m.id } }) : null;
  return { enquiryId: e.id, matchId: m.id, conversationId: c?.id ?? null };
}

export async function cleanup() {
  const ids = world.bizIds;
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: world.enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  const matches = (await prisma.match.findMany({ where: { enquiryId: { in: world.enquiryIds } }, select: { id: true } })).map((m) => m.id);
  await prisma.agentActionLog.deleteMany({ where: { principalBusinessId: { in: ids } } });
  await prisma.counterProposal.deleteMany({ where: { enquiryId: { in: world.enquiryIds } } });
  await prisma.quoteTerms.deleteMany({ where: { enquiryId: { in: world.enquiryIds } } });
  await prisma.buyerBounds.deleteMany({ where: { enquiryId: { in: world.enquiryIds } } });
  await prisma.quoteDraft.deleteMany({ where: { sellerBusinessId: { in: ids } } });
  await prisma.leadQuoteTiming.deleteMany({ where: { sellerBusinessId: { in: ids } } });
  await prisma.sellerPriceBook.deleteMany({ where: { sellerBusinessId: { in: ids } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: world.enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: world.enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${[...world.enquiryIds, ...convos, ...matches, ...ids]}) OR payload->>'sellerBusinessId' = ANY(${ids}) OR payload->>'buyerBusinessId' = ANY(${ids})`;
  await prisma.businessMember.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: ids } } });
  await prisma.person.deleteMany({ where: { id: { in: world.personIds } } });
}

export async function events(type: string, aggregateId: string) {
  return prisma.$queryRaw<{ payload: any }[]>`SELECT payload FROM domain_events WHERE type = ${type} AND aggregate_id = ${aggregateId}`;
}
