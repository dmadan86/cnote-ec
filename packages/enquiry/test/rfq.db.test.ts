// RFQ depth (budget, expiry, min tier, attachments) and the buyer quote comparison. ADR-002, ADR-007, ADR-008/010.
import { prisma } from "@cnote/db";
import { grantCredits } from "@cnote/billing";
import { LocalMediaStore, setMediaStore } from "@cnote/media";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  candidates: [] as { sellerBusinessId: string; listingId: string; similarity: number }[],
  profiles: new Map<string, unknown>(),
  intentInputs: [] as unknown[],
}));

vi.mock("@cnote/ai", () => ({
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false }),
  embed: async () => ({ vectors: [Array.from({ length: 256 }, (_, i) => (i % 5) / 5)], version: "test" }),
  scoreIntent: async (input: unknown) => {
    state.intentInputs.push(input);
    return { score: 80, reasons: ["Specific quantity"], decisionId: "d", confidence: 0.9, needsReview: false };
  },
}));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  listCategories: async () => [],
  getListing: async () => null,
  getPublicListing: async () => null,
  findSellerCandidates: async (o: { excludeSellerIds?: string[] }) => state.candidates.filter((c) => !o.excludeSellerIds?.includes(c.sellerBusinessId)),
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => state.profiles.has(i)).map((i) => [i, state.profiles.get(i)])),
  hasConsent: async () => true,
  getPersonContact: async () => ({ phone: "+919999900000" }),
}));

import {
  BOARD_STATUSES, MAX_RFQ_ATTACHMENTS, acceptLead, boardCounts, boardStatus, checkAttachment, createEnquiry, decideQuote, discardStored,
  getConversation, getQuoteComparison, listBuyerEnquiries, listSellerLeads, openAttachment, safeFileName, sendQuote, setQuoteShortlisted,
  storeAttachmentBytes,
} from "../src";

const tag = `rfq-test-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
let buyer: { personId: string; businessId: string };
let outsider: { personId: string; businessId: string };
const sellers: { personId: string; businessId: string }[] = [];
let dir: string;
let store: LocalMediaStore;

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const TXT = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);

async function party(name: string, tier = 1) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}` } });
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, city: "Pune" } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  personIds.push(p.id); bizIds.push(b.id);
  state.profiles.set(b.id, { businessId: b.id, name: `${tag}-${name}`, city: "Pune", state: "MH", pincode: "411001", verificationTier: tier, trustScore: 60 + tier, badgeActive: tier >= 1, languages: ["en"] });
  return { personId: p.id, businessId: b.id };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rfq-media-"));
  store = new LocalMediaStore(dir, "private");
  setMediaStore(store, "private");
  buyer = await party("buyer", 1);
  outsider = await party("outsider", 1);
  for (const tier of [1, 2, 3]) sellers.push(await party(`s${tier}`, tier));
  state.candidates = sellers.map((s, i) => ({ sellerBusinessId: s.businessId, listingId: randomUUID(), similarity: 0.9 - i * 0.05 }));
  for (const s of sellers) await grantCredits(s.businessId, 5, "test", { refType: "test", refId: "g" });
});

afterAll(async () => {
  setMediaStore(undefined);
  rmSync(dir, { recursive: true, force: true });
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  await prisma.enquiryAttachment.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  const matchIds = (await prisma.match.findMany({ where: { enquiryId: { in: enquiryIds } }, select: { id: true } })).map((m) => m.id);
  await prisma.order.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.dealReport.deleteMany({ where: { match: { enquiryId: { in: enquiryIds } } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...enquiryIds, ...convos]}) OR payload->>'buyerBusinessId' = ANY(${bizIds}) OR payload->>'businessId' = ANY(${bizIds}) OR payload->>'sellerBusinessId' = ANY(${bizIds})`;
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

const base = { title: "CNC machined brackets", requirement: "Need 200 CNC machined aluminium brackets, drawing attached" };
const post = async (extra: Record<string, unknown> = {}) => {
  const e = await createEnquiry(buyer, { ...base, quantity: 200, quantityUnit: "pcs", ...extra }, { buyerPhoneVerified: true });
  enquiryIds.push(e.id);
  return e;
};

describe("attachment checks", () => {
  it("decides the type from magic bytes, not the filename", () => {
    expect(checkAttachment({ fileName: "a.exe", bytes: PDF }, 100)).toMatchObject({ mime: "application/pdf", ext: "pdf" });
    expect(checkAttachment({ fileName: "a.pdf", bytes: PNG }, 100)).toMatchObject({ mime: "image/png", ext: "png" });
    expect(checkAttachment({ fileName: "a", bytes: JPG }, 100)).toMatchObject({ mime: "image/jpeg", ext: "jpg" });
    expect(() => checkAttachment({ fileName: "a.pdf", bytes: TXT }, 100)).toThrow(/PDF, JPG or PNG/);
    expect(() => checkAttachment({ fileName: "a.pdf", bytes: new Uint8Array() }, 100)).toThrow(/empty/);
    expect(() => checkAttachment({ fileName: "a.pdf", bytes: PDF }, 5)).toThrow(/smaller/);
  });
  it("sanitises display names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\x\\draw\u0000ing.pdf")).toBe("drawing.pdf");
    expect(safeFileName("   ")).toBe("attachment");
    expect(safeFileName("a".repeat(300))).toHaveLength(120);
  });
  it("removes already-written objects when a later write fails", async () => {
    const real = store.put.bind(store);
    let n = 0;
    store.put = async (k, b, ct) => {
      if (++n === 2) throw new Error("disk full");
      return real(k, b, ct);
    };
    const eid = randomUUID();
    const good = [{ fileName: "a.pdf", bytes: PDF, mime: "application/pdf" as const, ext: "pdf" as const }, { fileName: "b.pdf", bytes: PDF, mime: "application/pdf" as const, ext: "pdf" as const }];
    await expect(storeAttachmentBytes(eid, good, { actor: buyer, kind: "rfq" })).rejects.toThrow("disk full");
    store.put = real;
    expect(n).toBe(2);
    const stored = await storeAttachmentBytes(eid, good.slice(0, 1), { actor: buyer, kind: "rfq" });
    expect(await store.exists(stored[0]!.key)).toBe(true);
    await discardStored(stored);
    expect(await store.exists(stored[0]!.key)).toBe(false);
  });
});

describe("createEnquiry RFQ depth", () => {
  it("stores budget, 7-day default expiry, min tier and private attachments; emits EnquiryCreated v2", async () => {
    state.intentInputs.length = 0;
    const e = await post({
      targetPricePaise: 45000, budgetMinPaise: 40000, budgetMaxPaise: 52000, deliveryPincode: "411001", neededBy: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10),
      minSellerTier: 2,
      attachments: [{ fileName: "bracket drawing.pdf", bytes: PDF }, { fileName: "photo.png", bytes: PNG }, { fileName: "sketch.jpg", bytes: JPG }],
    });
    expect(e.budgetMinPaise).toBe(40000);
    expect(e.budgetMaxPaise).toBe(52000);
    expect(e.minSellerTier).toBe(2);
    const days = (new Date(e.expiresAt!).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(e.attachments.map((a) => a.fileName)).toEqual(["bracket drawing.pdf", "photo.png", "sketch.jpg"]);
    expect(e.attachments.map((a) => a.mimeType)).toEqual(["application/pdf", "image/png", "image/jpeg"]);

    // private bucket, key never contains the user's filename
    const rows = await prisma.enquiryAttachment.findMany({ where: { enquiryId: e.id } });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.key).toMatch(new RegExp(`^rfq/${e.id}/[0-9a-f-]{36}\\.(pdf|png|jpg)$`));
      expect(await store.exists(r.key)).toBe(true);
    }

    // ADR-008/010: the model sees text/number fields only, never an attachment
    expect(state.intentInputs).toHaveLength(1);
    const sent = JSON.stringify(state.intentInputs[0]);
    expect(Object.keys(state.intentInputs[0] as object).some((k) => /attach|file|bytes/i.test(k))).toBe(false);
    expect(sent).not.toMatch(/bracket drawing\.pdf|photo\.png|sketch\.jpg|rfq\//);

    const [ev] = await prisma.$queryRaw<{ version: number; payload: Record<string, unknown> }[]>`SELECT version, payload FROM domain_events WHERE type = 'EnquiryCreated' AND aggregate_id = ${e.id}`;
    expect(ev!.version).toBe(3);
    expect(ev!.payload).toMatchObject({ enquiryId: e.id, attachmentCount: 3, minSellerTier: 2 });
    expect(JSON.stringify(ev!.payload)).not.toContain("drawing");

    // min tier 2: only the tier-2 and tier-3 sellers are matched
    expect(e.matches.map((m) => m.sellerBusinessId).sort()).toEqual([sellers[1]!.businessId, sellers[2]!.businessId].sort());
  });

  it("defaults: no budget, no tier floor, no attachments; custom expiry honoured", async () => {
    const e = await post({ expiresInDays: 3 });
    expect(e.budgetMinPaise).toBeNull();
    expect(e.minSellerTier).toBeNull();
    expect(e.attachments).toEqual([]);
    expect(e.matches).toHaveLength(3);
    expect((new Date(e.expiresAt!).getTime() - Date.now()) / 864e5).toBeLessThan(3.01);
  });

  it("rejects bad input before writing anything", async () => {
    const before = await prisma.enquiry.count({ where: { buyerBusinessId: buyer.businessId } });
    await expect(post({ budgetMinPaise: 9000, budgetMaxPaise: 1000 })).rejects.toThrow(/Maximum budget/);
    await expect(post({ expiresInDays: 0 })).rejects.toThrow(/at least 1 day/);
    await expect(post({ expiresInDays: 31 })).rejects.toThrow(/at most 30/);
    await expect(post({ neededBy: "2020-01-01" })).rejects.toThrow(/past/);
    await expect(post({ attachments: Array.from({ length: MAX_RFQ_ATTACHMENTS + 1 }, (_, i) => ({ fileName: `f${i}.pdf`, bytes: PDF })) })).rejects.toThrow(/up to 5/);
    await expect(post({ attachments: [{ fileName: "x.pdf", bytes: TXT }] })).rejects.toThrow(/PDF, JPG or PNG/);
    await expect(post({ attachments: [{ fileName: "big.pdf", bytes: Object.assign(new Uint8Array(10 * 1024 * 1024 + 1), PDF) }] })).rejects.toThrow(/10 MB/);
    expect(await prisma.enquiry.count({ where: { buyerBusinessId: buyer.businessId } })).toBe(before);
  });
});

describe("attachment access", () => {
  it("buyer and offered sellers read it; outsiders and bad ids get null; signed URL used when the driver can sign", async () => {
    const e = await post({ attachments: [{ fileName: "spec.pdf", bytes: PDF }] });
    const id = e.attachments[0]!.id;
    const a = await openAttachment(buyer, id);
    expect(a).toMatchObject({ fileName: "spec.pdf", mimeType: "application/pdf", signedUrl: null });
    expect(Array.from(a!.bytes!)).toEqual(Array.from(PDF));
    const matched = sellers.find((s) => s.businessId === e.matches[0]!.sellerBusinessId)!;
    expect(await openAttachment(matched, id)).not.toBeNull();
    expect(await openAttachment(outsider, id)).toBeNull();
    expect(await openAttachment(buyer, "nope")).toBeNull();
    expect(await openAttachment(buyer, randomUUID())).toBeNull();

    // the seller lead view carries the new fields
    const lead = (await listSellerLeads(matched.businessId)).find((l) => l.enquiry.id === e.id)!;
    expect(lead.enquiry.attachments).toHaveLength(1);
    expect(lead.enquiry.expiresAt).toBe(e.expiresAt);

    // a declined/expired seller loses access
    await prisma.match.update({ where: { id: e.matches[0]!.id }, data: { status: "declined" } });
    expect(await openAttachment(matched, id)).toBeNull();

    // signing driver
    const signing = Object.create(store) as LocalMediaStore;
    (signing as unknown as { signedGetUrl: (k: string, ttl: number) => Promise<string> }).signedGetUrl = async (k, ttl) => `https://signed.example/${k}?ttl=${ttl}`;
    setMediaStore(signing, "private");
    expect((await openAttachment(buyer, id))!.signedUrl).toMatch(/^https:\/\/signed\.example\/rfq\/.+\?ttl=300$/);
    setMediaStore(store, "private");

    // object missing from storage
    await store.delete((await prisma.enquiryAttachment.findUniqueOrThrow({ where: { id } })).key);
    expect(await openAttachment(buyer, id)).toBeNull();
  });
});

describe("expiry", () => {
  it("a seller cannot accept once the buyer's quote deadline has passed", async () => {
    const e = await post();
    await prisma.enquiry.update({ where: { id: e.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const m = e.matches[0]!;
    await expect(acceptLead(sellers.find((s) => s.businessId === m.sellerBusinessId)!, m.id)).rejects.toThrow(/deadline/);
  });
});

describe("board status", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const e = (status: string, expiresAt: string | null, quoteCount?: number) => ({ status: status as never, expiresAt, quoteCount });
  it("derives open / quoted / closed / expired", () => {
    expect(boardStatus(e("matched", "2026-10-05T00:00:00Z", 0), now)).toBe("open");
    expect(boardStatus(e("matched", null), now)).toBe("open");
    expect(boardStatus(e("matched", "2026-10-05T00:00:00Z", 2), now)).toBe("quoted");
    expect(boardStatus(e("matched", "2026-09-30T00:00:00Z", 2), now)).toBe("expired");
    expect(boardStatus(e("matched", "2026-10-01T00:00:00Z", 0), now)).toBe("expired");
    expect(boardStatus(e("closed", "2026-09-30T00:00:00Z", 2), now)).toBe("closed");
    expect(boardStatus(e("rejected", null), now)).toBe("closed");
    expect(boardCounts([e("matched", null), e("matched", null, 1), e("closed", null), e("matched", "2020-01-01T00:00:00Z")], now)).toEqual({ open: 1, quoted: 1, closed: 1, expired: 1 });
    expect(BOARD_STATUSES).toEqual(["open", "quoted", "closed", "expired"]);
  });
});

describe("quote comparison", () => {
  it("lists latest quote per supplier with totals, N-of-M transparency, shortlist and accept/decline", async () => {
    const e = await post({ attachments: [{ fileName: "spec.pdf", bytes: PDF }] });
    expect(e.matches).toHaveLength(3);
    const bySeller = new Map(sellers.map((s) => [s.businessId, s]));
    const accepted = [];
    for (const m of e.matches.slice(0, 2)) accepted.push({ seller: bySeller.get(m.sellerBusinessId)!, lead: await acceptLead(bySeller.get(m.sellerBusinessId)!, m.id), rank: m.rank });

    // no quotes yet
    expect(await getQuoteComparison(buyer, e.id)).toMatchObject({ sentTo: 3, quotesFrom: 0, rows: [] });

    const [a, b] = accepted;
    await sendQuote(a!.seller, a!.lead.conversationId!, { pricePaise: 5000, quantity: 200, unit: "pcs", leadTimeDays: 10 });
    // replacement quote supersedes the first, with an attachment and structured terms
    const { quoteId: qa } = await sendQuote(a!.seller, a!.lead.conversationId!, {
      pricePaise: 4800, quantity: 200, unit: "pcs", leadTimeDays: 8, paymentTerms: "net_15", attachments: [{ fileName: "quote.pdf", bytes: PDF }],
    });
    const { quoteId: qb } = await sendQuote(b!.seller, b!.lead.conversationId!, { pricePaise: 4500, quantity: 100, unit: "pcs", leadTimeDays: 14 });
    await expect(sendQuote(b!.seller, b!.lead.conversationId!, { pricePaise: 1, quantity: 1, unit: "pcs", attachments: [{ fileName: "x", bytes: TXT }] })).rejects.toThrow(/PDF, JPG or PNG/);

    const cmp = (await getQuoteComparison(buyer, e.id))!;
    expect(cmp).toMatchObject({ sentTo: 3, quotesFrom: 2, quantity: 200 });
    expect(cmp.rows.map((r) => r.rank)).toEqual([...cmp.rows.map((r) => r.rank)].sort());
    const ra = cmp.rows.find((r) => r.sellerBusinessId === a!.seller.businessId)!;
    const rb = cmp.rows.find((r) => r.sellerBusinessId === b!.seller.businessId)!;
    expect(ra).toMatchObject({ totalPaise: 4800 * 200, quantityBasis: "requested", earlierQuotes: 1, decision: null });
    expect(ra.quote.paymentTerms).toBe("net_15");
    expect(ra.quote.attachments.map((x) => x.fileName)).toEqual(["quote.pdf"]);
    expect(rb.totalPaise).toBe(4500 * 200); // priced for the REQUESTED quantity, not the 100 the seller quoted
    expect(rb.quote.quantity).toBe(100);
    expect(ra.verificationTier).toBeGreaterThan(0);

    // buyer can open the quote attachment, the quoting seller can, another seller can't
    expect(await openAttachment(buyer, ra.quote.attachments[0]!.id)).not.toBeNull();
    expect(await openAttachment(a!.seller, ra.quote.attachments[0]!.id)).not.toBeNull();
    expect(await openAttachment(b!.seller, ra.quote.attachments[0]!.id)).toBeNull();

    // another business can't see the comparison
    expect(await getQuoteComparison(outsider, e.id)).toBeNull();
    expect(await getQuoteComparison(buyer, "bad")).toBeNull();

    // board: quote count and attachments
    const listed = (await listBuyerEnquiries(buyer.businessId)).find((x) => x.id === e.id)!;
    expect(listed.quoteCount).toBe(3);
    expect(listed.attachments).toHaveLength(1);
    expect(boardStatus(listed)).toBe("quoted");

    // shortlist: buyer only, toggles, never shown to the seller
    await setQuoteShortlisted(buyer, qa, true);
    expect((await getQuoteComparison(buyer, e.id))!.rows.find((r) => r.quote.id === qa)!.quote.shortlisted).toBe(true);
    await expect(setQuoteShortlisted(a!.seller, qa, true)).rejects.toMatchObject({ code: "not_found" });
    await expect(setQuoteShortlisted(outsider, qa, true)).rejects.toMatchObject({ code: "not_found" });
    expect((await getConversation(a!.seller, a!.lead.conversationId!))!.quotes.every((q) => q.shortlisted === undefined)).toBe(true);
    await setQuoteShortlisted(buyer, qa, false);
    expect((await getQuoteComparison(buyer, e.id))!.rows.find((r) => r.quote.id === qa)!.quote.shortlisted).toBe(false);

    // decline then accept (append-only; latest wins); accept records a won deal valued at price x requested quantity
    await decideQuote(buyer, qb, "decline");
    expect((await getQuoteComparison(buyer, e.id))!.rows.find((r) => r.quote.id === qb)!.decision).toBe("lost");
    await decideQuote(buyer, qa, "accept");
    expect((await getQuoteComparison(buyer, e.id))!.rows.find((r) => r.quote.id === qa)!.decision).toBe("won");
    const deal = await prisma.dealReport.findFirstOrThrow({ where: { matchId: ra.matchId, outcome: "won" } });
    expect(Number(deal.valuePaise)).toBe(4800 * 200);
    await expect(decideQuote(a!.seller, qa, "accept")).rejects.toMatchObject({ code: "not_found" });
    await expect(decideQuote(buyer, qa, "maybe" as never)).rejects.toMatchObject({ code: "validation" });
    await expect(decideQuote(buyer, randomUUID(), "accept")).rejects.toMatchObject({ code: "not_found" });
  });

  it("falls back to the quoted quantity when the buyer gave none", async () => {
    const e = await createEnquiry(buyer, { ...base }, { buyerPhoneVerified: true });
    enquiryIds.push(e.id);
    const m = e.matches[0]!;
    const seller = sellers.find((s) => s.businessId === m.sellerBusinessId)!;
    const lead = await acceptLead(seller, m.id);
    await sendQuote(seller, lead.conversationId!, { pricePaise: 100, quantity: 7, unit: "pcs" });
    const row = (await getQuoteComparison(buyer, e.id))!.rows[0]!;
    expect(row).toMatchObject({ quantityBasis: "quoted", quantity: 7, totalPaise: 700 });
  });
});
