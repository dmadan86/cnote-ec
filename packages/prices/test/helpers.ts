import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";

process.env.PRICE_INTEL_ENABLED = "1";
delete process.env.PRICE_K;
const tag = `prices-${randomUUID().slice(0, 8)}`;
const made = { business: [] as string[], person: [] as string[], category: [] as string[], enquiry: [] as string[], match: [] as string[], order: [] as string[] };

export async function mkCategory(name = "cat") {
  const c = await prisma.category.create({ data: { slug: `${tag}-${name}-${randomUUID().slice(0, 6)}`, name: `${tag} ${name}` } });
  made.category.push(c.id);
  return c;
}
export async function mkParty(n: number, seller: boolean) {
  const out: { businessId: string; personId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const p = await prisma.person.create({ data: { name: `${tag}-p${i}` } });
    const b = await prisma.business.create({ data: { name: `${tag}-${seller ? "s" : "b"}${i}`, isSeller: seller } });
    made.person.push(p.id); made.business.push(b.id);
    out.push({ businessId: b.id, personId: p.id });
  }
  return out;
}

export async function mkQuote(o: {
  categoryId: string; buyer: { businessId: string; personId: string }; seller: { businessId: string }; price: number; quantity?: number; unit?: string; pincode?: string | null;
  order?: boolean; createdAt?: Date;
}) {
  const e = await prisma.enquiry.create({
    data: { buyerBusinessId: o.buyer.businessId, buyerPersonId: o.buyer.personId, title: "t", requirement: "r", categoryId: o.categoryId, deliveryPincode: o.pincode === undefined ? "400001" : o.pincode },
  });
  made.enquiry.push(e.id);
  const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: o.seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
  made.match.push(m.id);
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  const q = await prisma.quote.create({
    data: { conversationId: c.id, sellerBusinessId: o.seller.businessId, pricePaise: BigInt(o.price), quantity: o.quantity ?? 10, unit: o.unit ?? "kg", ...(o.createdAt ? { createdAt: o.createdAt } : {}) },
  });
  if (o.order) {
    const ord = await prisma.order.create({
      data: { matchId: m.id, enquiryId: e.id, quoteId: q.id, buyerBusinessId: o.buyer.businessId, sellerBusinessId: o.seller.businessId, settlement: "escrow", status: "confirmed", pricePaise: BigInt(o.price), quantity: o.quantity ?? 10, unit: o.unit ?? "kg" },
    });
    made.order.push(ord.id);
  }
  return q.id;
}

/** n quotes for a category from n distinct sellers and n distinct buyers. */
export async function seedQualifying(categoryId: string, n = 6, base = 1000, opts: { unit?: string; pincode?: string | null; quantity?: number; escrowFirst?: number } = {}) {
  const [buyers, sellers] = await Promise.all([mkParty(n, false), mkParty(n, true)]);
  for (let i = 0; i < n; i++) {
    await mkQuote({ categoryId, buyer: buyers[i]!, seller: sellers[i]!, price: base + i * 10, unit: opts.unit, pincode: opts.pincode, quantity: opts.quantity, order: i < (opts.escrowFirst ?? 0) });
  }
  return { buyers, sellers };
}

export async function cleanup() {
  const cats = made.category;
  await prisma.priceBenchmark.deleteMany({ where: { categoryId: { in: cats } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { id: { in: made.order } } }).catch(() => {});
  const convos = (await prisma.conversation.findMany({ where: { matchId: { in: made.match } }, select: { id: true } })).map((c) => c.id);
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } }).catch(() => {});
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } }).catch(() => {});
  await prisma.match.deleteMany({ where: { id: { in: made.match } } }).catch(() => {});
  await prisma.enquiry.deleteMany({ where: { id: { in: made.enquiry } } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: { in: made.business } } }).catch(() => {});
  await prisma.person.deleteMany({ where: { id: { in: made.person } } }).catch(() => {});
  await prisma.category.deleteMany({ where: { id: { in: cats } } }).catch(() => {});
  await prisma.priceConfig.deleteMany({}).catch(() => {});
  await prisma.$executeRaw`DELETE FROM domain_events WHERE type = 'PriceBenchmarkPublished'`.catch(() => {});
  await prisma.priceBenchmarkRun.deleteMany({}).catch(() => {});
}
