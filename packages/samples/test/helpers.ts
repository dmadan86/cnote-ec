import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { setSamplePhotoStore, type SamplePhotoStore } from "../src";

export type Actor = { personId: string; businessId: string };

export class MemoryPhotoStore implements SamplePhotoStore {
  files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string) { this.files.set(key, { bytes, contentType }); }
  async get(key: string) { return this.files.get(key) ?? null; }
  async delete(key: string) { this.files.delete(key); }
}
export const installStore = () => { const s = new MemoryPhotoStore(); setSamplePhotoStore(s); return s; };

/** Smallest bytes that sniff as a JPEG / PNG. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export const SHIP = { name: "Asha Rao", phone: "9876543210", line1: "12 MG Road", line2: null, city: "Bengaluru", pincode: "560001" };

/** Tracks every row a test file creates so it can clean up after itself. */
export class Fixtures {
  tag = `smp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  bizIds: string[] = [];
  personIds: string[] = [];
  enquiryIds: string[] = [];
  matchIds: string[] = [];
  orderIds: string[] = [];
  sampleIds: string[] = [];
  private n = 0;

  async party(name: string, tier = 0): Promise<Actor> {
    const label = `${this.tag}-${name}-${++this.n}`;
    const p = await prisma.person.create({ data: { name: label } });
    const b = await prisma.business.create({ data: { name: label, verificationTier: tier } });
    this.personIds.push(p.id); this.bizIds.push(b.id);
    return { personId: p.id, businessId: b.id };
  }

  /** buyer + seller + enquiry + accepted match + conversation + a quote. */
  async deal(opts: { buyerTier?: number; order?: boolean } = {}) {
    const buyer = await this.party("buyer", opts.buyerTier ?? 0);
    const seller = await this.party("seller", 1);
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes", requirement: "Need 1000 corrugated boxes" } });
    this.enquiryIds.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    this.matchIds.push(m.id);
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: 10_000n, quantity: 1000, unit: "box", leadTimeDays: 5 } });
    let orderId: string | null = null;
    if (opts.order) {
      const o = await prisma.order.create({
        data: { matchId: m.id, enquiryId: e.id, quoteId: q.id, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, status: "recorded", pricePaise: 10_000n, quantity: 1000, unit: "box", totalPaise: 10_000_000n },
      });
      orderId = o.id; this.orderIds.push(o.id);
    }
    return { buyer, seller, enquiryId: e.id, matchId: m.id, conversationId: c.id, quoteId: q.id, orderId };
  }

  track(id: string) { this.sampleIds.push(id); return id; }

  async cleanup() {
    const ids = [...new Set(this.sampleIds)];
    const bySeller = (await prisma.sampleRequest.findMany({ where: { OR: [{ buyerBusinessId: { in: this.bizIds } }, { sellerBusinessId: { in: this.bizIds } }] }, select: { id: true } })).map((s) => s.id);
    const all = [...new Set([...ids, ...bySeller])];
    await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${all}) OR payload->>'sampleId' = ANY(${all})`;
    await prisma.sampleRequest.deleteMany({ where: { id: { in: all } } }); // cascades media + status log
    await prisma.order.deleteMany({ where: { id: { in: this.orderIds } } });
    const convos = (await prisma.conversation.findMany({ where: { matchId: { in: this.matchIds } }, select: { id: true } })).map((c) => c.id);
    await prisma.dealReport.deleteMany({ where: { matchId: { in: this.matchIds } } });
    await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
    await prisma.match.deleteMany({ where: { id: { in: this.matchIds } } });
    await prisma.enquiry.deleteMany({ where: { id: { in: this.enquiryIds } } });
    await prisma.business.deleteMany({ where: { id: { in: this.bizIds } } });
    await prisma.person.deleteMany({ where: { id: { in: this.personIds } } });
  }
}

export const eventsFor = (type: string, sampleId: string) =>
  prisma.$queryRaw<{ payload: Record<string, unknown> }[]>`SELECT payload FROM domain_events WHERE type = ${type} AND payload->>'sampleId' = ${sampleId} ORDER BY id`;

export const uid = () => randomUUID();
