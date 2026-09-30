import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { setEvidenceStore, type EvidenceStore } from "../src";

export type Actor = { personId: string; businessId: string };

export class MemoryEvidenceStore implements EvidenceStore {
  files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string) { this.files.set(key, { bytes, contentType }); }
  async get(key: string) { return this.files.get(key) ?? null; }
  async delete(key: string) { this.files.delete(key); }
}
export const installStore = () => { const s = new MemoryEvidenceStore(); setEvidenceStore(s); return s; };

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
export const PDF = new TextEncoder().encode("%PDF-1.4 test");
export const voice = (text: string) => new TextEncoder().encode(`CNOTE-MOCK-TRANSCRIPT:${text}`);

/** Tracks every row a test file creates so it can clean up after itself. */
export class Fixtures {
  tag = `dsp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  bizIds: string[] = [];
  personIds: string[] = [];
  enquiryIds: string[] = [];
  matchIds: string[] = [];
  orderIds: string[] = [];
  disputeIds: string[] = [];
  private n = 0;

  async party(name: string): Promise<Actor> {
    const label = `${this.tag}-${name}-${++this.n}`;
    const p = await prisma.person.create({ data: { name: label } });
    const b = await prisma.business.create({ data: { name: label } });
    this.personIds.push(p.id); this.bizIds.push(b.id);
    return { personId: p.id, businessId: b.id };
  }

  /** buyer + seller + enquiry + accepted match + conversation (+ quote, messages) + order. */
  async order(opts: { status?: "recorded" | "confirmed" | "dispatched" | "delivered" | "completed" | "cancelled"; quantity?: number; unitPricePaise?: number; withQuote?: boolean; messages?: string[] } = {}) {
    const buyer = await this.party("buyer");
    const seller = await this.party("seller");
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Corrugated boxes", requirement: "Need 100 corrugated boxes" } });
    this.enquiryIds.push(e.id);
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date() } });
    this.matchIds.push(m.id);
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    const quantity = opts.quantity ?? 100;
    const price = opts.unitPricePaise ?? 10_000;
    let quoteId: string | null = null;
    if (opts.withQuote !== false) {
      const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: seller.businessId, pricePaise: BigInt(price), quantity, unit: "box", leadTimeDays: 5 } });
      quoteId = q.id;
    }
    let t = Date.now() - 60_000;
    for (const [i, body] of (opts.messages ?? []).entries()) {
      await prisma.message.create({ data: { conversationId: c.id, senderPersonId: i % 2 === 0 ? buyer.personId : seller.personId, body, createdAt: new Date(t += 1000) } });
    }
    const o = await prisma.order.create({
      data: {
        matchId: m.id, enquiryId: e.id, quoteId, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId, status: opts.status ?? "delivered",
        pricePaise: BigInt(price), quantity, unit: "box", totalPaise: BigInt(price * quantity), buyerConfirmedAt: new Date(), sellerConfirmedAt: new Date(),
      },
    });
    this.orderIds.push(o.id);
    return { buyer, seller, orderId: o.id, matchId: m.id, conversationId: c.id, totalPaise: price * quantity };
  }

  track(disputeId: string) { this.disputeIds.push(disputeId); return disputeId; }

  async cleanup() {
    const disputes = (await prisma.dispute.findMany({ where: { orderId: { in: this.orderIds } }, select: { id: true } })).map((d) => d.id);
    const ids = [...new Set([...disputes, ...this.disputeIds])];
    await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id::text = ANY(${ids}) OR payload->>'disputeId' = ANY(${ids})`;
    const decisions = (await prisma.aiDecision.findMany({ where: { subjectId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await prisma.reviewItem.deleteMany({ where: { aiDecisionId: { in: decisions } } });
    await prisma.aiDecision.deleteMany({ where: { id: { in: decisions } } });
    await prisma.dispute.deleteMany({ where: { id: { in: ids } } }); // cascades evidence, briefs, decisions, messages, appeals
    await prisma.order.deleteMany({ where: { id: { in: this.orderIds } } });
    const convos = (await prisma.conversation.findMany({ where: { matchId: { in: this.matchIds } }, select: { id: true } })).map((c) => c.id);
    await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
    await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
    await prisma.match.deleteMany({ where: { id: { in: this.matchIds } } });
    await prisma.enquiry.deleteMany({ where: { id: { in: this.enquiryIds } } });
    await prisma.business.deleteMany({ where: { id: { in: this.bizIds } } });
    await prisma.person.deleteMany({ where: { id: { in: this.personIds } } });
  }
}

export const eventsFor = (type: string, disputeId: string) =>
  prisma.$queryRaw<{ payload: Record<string, unknown> }[]>`SELECT payload FROM domain_events WHERE type = ${type} AND payload->>'disputeId' = ${disputeId} ORDER BY id`;

export const uid = () => randomUUID();
