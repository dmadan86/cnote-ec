import { randomUUID } from "node:crypto";
import { recordPrice } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { setListingLookup, type ListingFacts } from "../src/index";

delete process.env.REVALIDATE_SECRET; // never call the web tier from tests
export const DAY = 86_400_000;
export const tag = randomUUID().slice(0, 8);
export const uid = () => randomUUID();

const created = { business: [] as string[], listing: [] as string[], person: [] as string[], category: [] as string[] };
const facts = new Map<string, ListingFacts>();
setListingLookup(async (id) => facts.get(id) ?? null);

export async function mkBusiness(tier = 1, opts: { seller?: boolean; phone?: string } = {}) {
  const b = await prisma.business.create({ data: { name: `Promo ${tag} ${randomUUID().slice(0, 4)}`, isSeller: opts.seller ?? true, verificationTier: tier } });
  created.business.push(b.id);
  let personId: string | null = null;
  if (opts.phone !== undefined) {
    const p = await prisma.person.create({ data: { phone: opts.phone || null, name: "P" } });
    created.person.push(p.id);
    await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id, role: "owner" } });
    personId = p.id;
  }
  return { id: b.id, personId };
}

export async function shareMember(personId: string, businessId: string) {
  await prisma.businessMember.create({ data: { businessId, personId, role: "staff" } });
}

let catId: string | null = null;
export async function mkListing(sellerBusinessId: string, o: { pricePaise?: number | null; moq?: number | null; historyDays?: number; historyPaise?: number } = {}) {
  if (!catId) {
    const c = await prisma.category.create({ data: { slug: `promo-${tag}`, name: "Promo test", attributeSchema: { fields: [] } } });
    catId = c.id;
    created.category.push(c.id);
  }
  const price = o.pricePaise === undefined ? 10_000 : o.pricePaise;
  const l = await prisma.listing.create({ data: { sellerBusinessId, categoryId: catId, title: `Promo listing ${randomUUID().slice(0, 6)}`, pricePaise: price === null ? null : BigInt(price), moq: o.moq === undefined ? 10 : o.moq } });
  created.listing.push(l.id);
  const f: ListingFacts = { id: l.id, sellerBusinessId, title: l.title, categorySlug: `promo-${tag}`, pricePaise: price, priceUnit: "piece", moq: o.moq === undefined ? 10 : o.moq, published: true };
  facts.set(l.id, f);
  if (o.historyDays !== undefined) await recordPrice(l.id, o.historyPaise ?? price, "piece", undefined, new Date(Date.now() - o.historyDays * DAY));
  return f;
}
export const setListing = (id: string, patch: Partial<ListingFacts>) => void facts.set(id, { ...facts.get(id)!, ...patch });

export async function cleanup() {
  const l = created.listing;
  const offers = (await prisma.listingOffer.findMany({ where: { listingId: { in: l } }, select: { id: true } })).map((o) => o.id);
  await prisma.offerHonourReport.deleteMany({ where: { offerId: { in: offers } } });
  await prisma.listingOffer.deleteMany({ where: { listingId: { in: l } } });
  await prisma.promotionItem.deleteMany({ where: { listingId: { in: l } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listingId: { in: l } } });
  await prisma.couponRedemption.deleteMany({ where: { businessId: { in: created.business } } });
  await prisma.referral.deleteMany({ where: { OR: [{ referrerBusinessId: { in: created.business } }, { refereeBusinessId: { in: created.business } }] } });
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: created.business } } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: [...l, ...offers] } }, { payload: { path: ["sellerBusinessId"], string_contains: tag } }] } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { id: { in: l } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: created.business } } });
  await prisma.business.deleteMany({ where: { id: { in: created.business } } });
  await prisma.person.deleteMany({ where: { id: { in: created.person } } });
  await prisma.category.deleteMany({ where: { id: { in: created.category } } });
}
