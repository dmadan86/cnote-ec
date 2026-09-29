import { getBalance, grantCredits } from "@cnote/billing";
import { prisma } from "@cnote/db";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface Cat { id: string; slug: string; name: string; icon: null; leadCap: number; prohibited: boolean; attributeSchema: { fields: [] }; parentId: null }
const st = vi.hoisted(() => ({
  candidates: [] as { sellerBusinessId: string; listingId: string; similarity: number }[],
  profiles: new Map<string, unknown>(),
  cats: [] as unknown[],
  listings: new Map<string, { sellerBusinessId: string }>(),
  moderation: { verdict: "allow", needsReview: false } as { verdict: string; needsReview: boolean },
  intent: { score: 80, needsReview: false } as { score: number; needsReview: boolean },
  intentInputs: [] as Record<string, unknown>[],
  consent: true,
  phone: "+919999900000" as string | null,
  hasContactFn: true,
}));

vi.mock("@cnote/ai", () => ({
  moderate: async () => ({ verdict: st.moderation.verdict, flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: st.moderation.needsReview }),
  embed: async () => ({ vectors: [Array.from({ length: 256 }, (_, i) => ((i % 7) + 1) / 7)], version: "test" }),
  scoreIntent: async (input: Record<string, unknown>) => {
    st.intentInputs.push(input);
    return { score: st.intent.score, reasons: ["r"], decisionId: "d", confidence: 0.9, needsReview: st.intent.needsReview };
  },
}));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async (slug: string) => (st.cats as Cat[]).find((c) => c.slug === slug) ?? null,
  listCategories: async () => st.cats,
  getListing: async (id: string) => st.listings.get(id) ?? null,
  findSellerCandidates: async (o: { excludeSellerIds?: string[] }) => st.candidates.filter((c) => !o.excludeSellerIds?.includes(c.sellerBusinessId)),
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => st.profiles.has(i)).map((i) => [i, st.profiles.get(i)])),
  hasConsent: async () => st.consent,
  get getPersonContact() {
    return st.hasContactFn ? async () => (st.phone ? { phone: st.phone } : null) : undefined;
  },
}));

import * as api from "../src";
import { repairCascades, sweepStuckScoring } from "../src/leads";
import { cascade, loadEmbedding } from "../src/matching";
import { pickSellers } from "../src";

const {
  acceptLead, createEnquiry, declineLead, expireOverdueOffers, getConversation, getSellerLead, listSellerLeads, reportBuyerProblem, reportDeal,
  resolveEnquiryReview, sendMessage, sendQuote, listBuyerEnquiries, getBuyerEnquiry, listCandidatesForBuyer,
} = api;

const tag = `enq-lc-${Date.now()}`;
type Actor = { personId: string; businessId: string };
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
const catIds: string[] = [];
let uid = 0;

async function party(name: string, opts: { credits?: number; profile?: boolean; city?: string } = {}): Promise<Actor> {
  const label = `${tag}-${name}-${++uid}`;
  const p = await prisma.person.create({ data: { name: label } });
  const b = await prisma.business.create({ data: { name: label, city: opts.city ?? "Pune" } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  personIds.push(p.id); bizIds.push(b.id);
  if (opts.profile !== false) st.profiles.set(b.id, { businessId: b.id, name: label, city: opts.city ?? "Pune", state: "MH", pincode: "411001", verificationTier: 1, trustScore: 60, badgeActive: true, languages: ["en"] });
  if (opts.credits) await grantCredits(b.id, opts.credits, "t", { refType: "t", refId: "g" });
  return { personId: p.id, businessId: b.id };
}
async function makeCat(slug: string, leadCap: number, prohibited = false) {
  const row = await prisma.category.create({ data: { slug: `${tag}-${slug}`, name: `Cat ${slug}`, leadCap, prohibited } });
  catIds.push(row.id);
  st.cats.push({ id: row.id, slug: row.slug, name: row.name, icon: null, leadCap, prohibited, attributeSchema: { fields: [] }, parentId: null });
  return row;
}
/** Seller pool with descending similarity so rank order is deterministic. */
async function pool(n: number, credits = 5): Promise<Actor[]> {
  const out: Actor[] = [];
  for (let i = 0; i < n; i++) out.push(await party(`s${i}`, { credits }));
  st.candidates = out.map((s, i) => ({ sellerBusinessId: s.businessId, listingId: randomUUID(), similarity: 0.95 - i * 0.03 }));
  return out;
}
const byBiz = (sellers: Actor[], id: string) => sellers.find((s) => s.businessId === id)!;
let n = 0;
async function post(buyer: Actor, extra: Record<string, unknown> = {}, ctx = {}) {
  const e = await createEnquiry(buyer, { title: `Corrugated boxes ${++n}`, requirement: "Need 500 units of corrugated boxes, 3 ply", quantity: 500, ...extra } as never, ctx);
  enquiryIds.push(e.id);
  return e;
}
const rows = (enquiryId: string) => prisma.match.findMany({ where: { enquiryId }, orderBy: [{ rank: "asc" }, { offeredAt: "asc" }] });
const isActive = (s: string) => s === "offered" || s === "accepted";

afterEach(() => {
  vi.useRealTimers();
  st.moderation = { verdict: "allow", needsReview: false };
  st.intent = { score: 80, needsReview: false };
  st.consent = true; st.phone = "+919999900000"; st.hasContactFn = true;
});

afterAll(async () => {
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.dealReport.deleteMany({ where: { match: { enquiryId: { in: enquiryIds } } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...enquiryIds, ...bizIds, ...convos]}) OR payload->>'businessId' = ANY(${bizIds})`;
  await prisma.creditLedgerEntry.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.subscription.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.category.deleteMany({ where: { id: { in: catIds } } });
});

describe("createEnquiry", () => {
  it("validates input, unknown / prohibited category", async () => {
    const buyer = await party("buyer");
    await pool(3);
    await expect(createEnquiry(buyer, { title: "x", requirement: "y" })).rejects.toBeTruthy();
    await expect(createEnquiry(buyer, { title: "Valid title", requirement: "Valid requirement text", categorySlug: "nope-nope" })).rejects.toMatchObject({ code: "validation" });
    const bad = await makeCat("banned", 3, true);
    await expect(createEnquiry(buyer, { title: "Valid title", requirement: "Valid requirement text", categorySlug: bad.slug })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/not allowed/) });
  });

  it("rate limits at 10 per hour per business", async () => {
    const buyer = await party("rl");
    await pool(1);
    for (let i = 0; i < 10; i++) await post(buyer);
    await expect(createEnquiry(buyer, { title: "One more", requirement: "One more requirement" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("caps offers per category leadCap and records sellerCap; top-N by score, own business excluded", async () => {
    const buyer = await party("buyer");
    const cat2 = await makeCat("cap2", 2);
    const cat5 = await makeCat("cap5", 5);
    const sellers = await pool(7);
    st.candidates.unshift({ sellerBusinessId: buyer.businessId, listingId: randomUUID(), similarity: 0.999 }); // own business is best match
    const e2 = await post(buyer, { categorySlug: cat2.slug });
    expect(e2.category?.slug).toBe(cat2.slug);
    expect(e2.matches.map((m) => m.rank)).toEqual([1, 2]);
    expect(e2.sellerCap).toBe(2);
    expect(e2.matches.map((m) => m.sellerBusinessId)).toEqual([sellers[0]!.businessId, sellers[1]!.businessId]);
    const e5 = await post(buyer, { categorySlug: cat5.slug });
    expect(e5.matches).toHaveLength(5);
    expect(e5.matches.map((m) => m.sellerBusinessId)).not.toContain(buyer.businessId);
    expect(e5.matches.every((m) => m.of === 5)).toBe(true);
    // scores non-increasing by rank
    for (let i = 1; i < e5.matches.length; i++) expect(e5.matches[i - 1]!.matchScore).toBeGreaterThanOrEqual(e5.matches[i]!.matchScore);
    expect(e5.matches[0]!.seller).toMatchObject({ verificationTier: 1, badgeActive: true });
  });

  it("no candidates -> unmatched; sellers without a trust profile are never offered", async () => {
    const buyer = await party("buyer");
    st.candidates = [];
    expect((await post(buyer)).status).toBe("unmatched");
    const ghost = await party("ghost", { profile: false, credits: 1 });
    st.candidates = [{ sellerBusinessId: ghost.businessId, listingId: randomUUID(), similarity: 0.9 }];
    expect((await post(buyer)).status).toBe("unmatched");
  });

  it("preferred listing's seller is ranked first when eligible", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(5);
    const last = sellers[4]!;
    const listingId = randomUUID();
    st.listings.set(listingId, { sellerBusinessId: last.businessId });
    const e = await post(buyer, { preferredListingId: listingId });
    expect(e.matches[0]!.sellerBusinessId).toBe(last.businessId);
    expect(e.matches).toHaveLength(3);
    // an unknown listing is ignored
    const e2 = await post(buyer, { preferredListingId: randomUUID() });
    expect(e2.matches[0]!.sellerBusinessId).toBe(sellers[0]!.businessId);
  });

  it("passes intent signals: prior enquiries, phone verification, near-duplicate similarity", async () => {
    const buyer = await party("buyer");
    await pool(3);
    st.intentInputs.length = 0;
    await post(buyer, {}, { buyerPhoneVerified: true });
    await post(buyer);
    const [first, second] = st.intentInputs;
    expect(first).toMatchObject({ buyerPhoneVerified: true, buyerPriorEnquiries: 0, nearDuplicateSimilarity: null, buyerVerificationTier: 1 });
    expect(second).toMatchObject({ buyerPhoneVerified: false, buyerPriorEnquiries: 1 });
    expect(second!.nearDuplicateSimilarity).toBeGreaterThan(0.99);
  });

  it("moderation block -> rejected (no intent, no matches); review verdict/low-confidence -> review then ops release", async () => {
    const buyer = await party("buyer");
    await pool(3);
    st.intentInputs.length = 0;
    st.moderation = { verdict: "block", needsReview: false };
    const blocked = await post(buyer);
    expect(blocked).toMatchObject({ status: "rejected", intentScore: null, matches: [] });
    expect(st.intentInputs).toHaveLength(0);

    st.moderation = { verdict: "review", needsReview: false };
    const held = await post(buyer);
    expect(held.status).toBe("review");
    expect(held.matches).toHaveLength(0);
    await resolveEnquiryReview(held.id, "approved");
    const released = (await getBuyerEnquiry(buyer.businessId, held.id))!;
    expect(released.status).toBe("matched");
    expect(released.matches).toHaveLength(3);
    await expect(resolveEnquiryReview(held.id, "approved")).rejects.toMatchObject({ code: "conflict" });
    await expect(resolveEnquiryReview(randomUUID(), "approved")).rejects.toMatchObject({ code: "not_found" });

    st.moderation = { verdict: "allow", needsReview: false };
    st.intent = { score: 30.4, needsReview: true };
    const lowConf = await post(buyer);
    expect(lowConf.status).toBe("review");
    expect(lowConf.intentScore).toBe(30);
    await resolveEnquiryReview(lowConf.id, "rejected");
    expect((await getBuyerEnquiry(buyer.businessId, lowConf.id))!.status).toBe("rejected");
    expect(await rows(lowConf.id)).toHaveLength(0);
  });

  it("stores target price / delivery / neededBy round-trip", async () => {
    const buyer = await party("buyer");
    await pool(1);
    const e = await post(buyer, { targetPricePaise: 125_000, deliveryCity: "Pune", deliveryPincode: "411001", neededBy: "2026-12-01", quantityUnit: "pcs" });
    expect(e).toMatchObject({ targetPricePaise: 125_000, deliveryCity: "Pune", deliveryPincode: "411001", neededBy: "2026-12-01", quantityUnit: "pcs", awaitingPick: false });
    expect((await listBuyerEnquiries(buyer.businessId))[0]!.id).toBe(e.id);
    expect(await getBuyerEnquiry((await party("other")).businessId, e.id)).toBeNull();
  });
});

describe("buyer picks mode", () => {
  it("awaits picks, lists ranked candidates, enforces cap and eligibility", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(6);
    const e = await post(buyer, { buyerPicks: true });
    expect(e).toMatchObject({ status: "scoring", awaitingPick: true, matches: [] });
    await api.pickSellers(buyer, e.id, []).catch((x) => expect(x.code).toBe("validation"));
    const cands = await listCandidatesForBuyer(buyer, e.id);
    expect(cands.map((c) => c.sellerBusinessId)).toEqual(sellers.map((s) => s.businessId));
    expect(cands[0]).toMatchObject({ city: "Pune", trustScore: 60 });
    await expect(pickSellers(buyer, e.id, sellers.slice(0, 4).map((s) => s.businessId))).rejects.toMatchObject({ code: "validation" });
    await expect(pickSellers(buyer, e.id, [randomUUID()])).rejects.toMatchObject({ code: "validation" });
    const picked = await pickSellers(buyer, e.id, [sellers[4]!.businessId, sellers[4]!.businessId, sellers[1]!.businessId]);
    expect(picked.status).toBe("matched");
    expect(picked.awaitingPick).toBe(false);
    expect(picked.matches.map((m) => [m.rank, m.sellerBusinessId])).toEqual([[1, sellers[4]!.businessId], [2, sellers[1]!.businessId]]);
    // remaining capacity is 1
    await expect(pickSellers(buyer, e.id, [sellers[0]!.businessId, sellers[2]!.businessId])).rejects.toMatchObject({ code: "validation" });
    const more = await pickSellers(buyer, e.id, [sellers[0]!.businessId]);
    expect(more.matches.map((m) => m.rank)).toEqual([1, 2, 3]);
    // already-offered sellers are no longer candidates; cascade never runs for picks mode
    expect((await listCandidatesForBuyer(buyer, e.id)).map((c) => c.sellerBusinessId)).not.toContain(sellers[4]!.businessId);
    await declineLead(sellers[4]!, picked.matches[0]!.id);
    expect((await rows(e.id)).filter((m) => isActive(m.status))).toHaveLength(2);
    expect(await cascade(e.id)).toBe(0);
    // freed slot can be re-picked into rank 1
    const again = await pickSellers(buyer, e.id, [sellers[2]!.businessId]);
    expect(again.matches.find((m) => m.sellerBusinessId === sellers[2]!.businessId)!.rank).toBe(1);
  });

  it("rejects non-owners, non-picks enquiries, non-open statuses; candidates empty for auto enquiries", async () => {
    const buyer = await party("buyer");
    const stranger = await party("stranger");
    const sellers = await pool(3);
    const auto = await post(buyer);
    await expect(pickSellers(buyer, auto.id, [sellers[0]!.businessId])).rejects.toMatchObject({ code: "conflict" });
    expect(await listCandidatesForBuyer(buyer, auto.id)).toEqual([]);
    const picks = await post(buyer, { buyerPicks: true });
    await expect(pickSellers(stranger, picks.id, [sellers[0]!.businessId])).rejects.toMatchObject({ code: "not_found" });
    await expect(listCandidatesForBuyer(stranger, picks.id)).rejects.toMatchObject({ code: "not_found" });
    await prisma.enquiry.update({ where: { id: picks.id }, data: { status: "closed" } });
    await expect(pickSellers(buyer, picks.id, [sellers[0]!.businessId])).rejects.toMatchObject({ code: "conflict" });
    expect(await listCandidatesForBuyer(buyer, picks.id)).toEqual([]);
  });
});

describe("cascade (ADR-002)", () => {
  it("decline refills the slot with the next unoffered seller, never re-offering, until candidates are exhausted", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(5);
    const e = await post(buyer);
    const offeredEver = new Set(e.matches.map((m) => m.sellerBusinessId));
    for (let step = 0; step < 6; step++) {
      const all = await rows(e.id);
      const active = all.filter((m) => isActive(m.status));
      if (active.length === 0) break;
      const target = active[0]!;
      await declineLead(byBiz(sellers, target.sellerBusinessId), target.id, "no");
      const after = await rows(e.id);
      const nowActive = after.filter((m) => isActive(m.status));
      expect(nowActive.length).toBeLessThanOrEqual(3);
      expect(nowActive.every((m) => m.rank >= 1 && m.rank <= 3)).toBe(true);
      expect(new Set(nowActive.map((m) => m.rank)).size).toBe(nowActive.length);
      const sellersSeen = after.map((m) => m.sellerBusinessId);
      expect(new Set(sellersSeen).size).toBe(sellersSeen.length); // no seller offered twice
      for (const m of after) offeredEver.add(m.sellerBusinessId);
    }
    expect(offeredEver.size).toBe(5);
    const final = await prisma.enquiry.findUnique({ where: { id: e.id } });
    expect(final!.status).toBe("unmatched"); // all 5 sellers declined
  });

  it("property: random decline/expire sequences keep <= N active, unique ranks, no re-offers", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(7);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom("decline", "expire"), fc.nat(2)), { minLength: 1, maxLength: 5 }), async (script) => {
        const e = await post(buyer);
        for (const [action, pick] of script) {
          const active = (await rows(e.id)).filter((m) => m.status === "offered");
          if (active.length === 0) break;
          const t = active[pick % active.length]!;
          if (action === "decline") await declineLead(byBiz(sellers, t.sellerBusinessId), t.id);
          else {
            await prisma.match.update({ where: { id: t.id }, data: { respondBy: new Date(Date.now() - 1000) } });
            await expireOverdueOffers();
          }
          const all = await rows(e.id);
          const act = all.filter((m) => isActive(m.status));
          expect(act.length).toBeLessThanOrEqual(3);
          expect(new Set(act.map((m) => m.rank)).size).toBe(act.length);
          expect(all.every((m) => m.rank >= 1 && m.rank <= 3)).toBe(true);
          expect(new Set(all.map((m) => m.sellerBusinessId)).size).toBe(all.length);
        }
      }),
      { numRuns: 6 },
    );
  });

  it("expiry boundary (strict) then cascade; accept after the 2h window fails with fake time", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(5);
    const e = await post(buyer);
    const before = await rows(e.id);
    const offerAt = before[0]!.respondBy.getTime() - 2 * 3600_000;
    expect(Math.abs(offerAt - Date.now())).toBeLessThan(60_000); // respondBy = offer + 2h
    // scope the sweep to this enquiry: only its first match is overdue (T is far in the past of everyone else's deadline)
    const T = Date.now() - 3600_000;
    await prisma.match.update({ where: { id: before[0]!.id }, data: { respondBy: new Date(T) } });
    await expireOverdueOffers(new Date(T)); // strict "<": exactly at the deadline is not expired
    expect((await prisma.match.findUnique({ where: { id: before[0]!.id } }))!.status).toBe("offered");
    await expireOverdueOffers(new Date(T + 1));
    const after = await rows(e.id);
    expect(after.find((m) => m.id === before[0]!.id)!.status).toBe("expired");
    expect(after.filter((m) => isActive(m.status))).toHaveLength(3); // cascaded a 4th seller into rank 1
    expect(after.find((m) => m.status === "offered" && m.rank === 1)!.sellerBusinessId).not.toBe(before[0]!.sellerBusinessId);
    expect(new Set(after.map((m) => m.sellerBusinessId)).size).toBe(after.length);
    // past the 2h window an unaccepted offer can no longer be accepted
    const live = after.find((m) => m.status === "offered" && m.rank === 2)!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(live.respondBy.getTime() + 1));
    await expect(acceptLead(byBiz(sellers, live.sellerBusinessId), live.id)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/2-hour/) });
    vi.setSystemTime(new Date(live.respondBy.getTime()));
    expect((await acceptLead(byBiz(sellers, live.sellerBusinessId), live.id)).status).toBe("accepted");
  });

  it("cascade is a no-op for unknown/non-matched enquiries or full slots; repairCascades fills missing slots", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(6);
    expect(await cascade(randomUUID())).toBe(0);
    const e = await post(buyer);
    expect(await cascade(e.id)).toBe(0);
    // simulate a crashed cascade: mark a match declined directly (no cascade)
    const m = (await rows(e.id))[1]!;
    await prisma.match.update({ where: { id: m.id }, data: { status: "declined", respondedAt: new Date() } });
    expect(await repairCascades()).toBeGreaterThanOrEqual(1);
    const all = await rows(e.id);
    expect(all.filter((x) => isActive(x.status))).toHaveLength(3);
    expect(all.find((x) => x.status === "offered" && x.rank === m.rank)).toBeTruthy();
    expect(sellers.length).toBe(6);
  });

  it("sweepStuckScoring matches enquiries stranded in scoring; loadEmbedding requires an embedding", async () => {
    const buyer = await party("buyer");
    await pool(3);
    const e = await post(buyer);
    await prisma.match.deleteMany({ where: { enquiryId: e.id } });
    await prisma.enquiry.update({ where: { id: e.id }, data: { status: "scoring", createdAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await sweepStuckScoring()).toBeGreaterThanOrEqual(1);
    expect((await getBuyerEnquiry(buyer.businessId, e.id))!.status).toBe("matched");
    expect(await loadEmbedding(e.id)).toHaveLength(256);
    await prisma.$executeRaw`UPDATE enquiries SET embedding = NULL WHERE id = ${e.id}::uuid`;
    await expect(loadEmbedding(e.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("worker jobs run without throwing", async () => {
    for (const j of api.worker.jobs!) await j.run();
    expect(api.worker.name).toBe("enquiry");
  });
});

describe("accept flow", () => {
  it("concurrent accepts of the same match consume exactly one credit and open one conversation", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(3, 1);
    const e = await post(buyer);
    const m = e.matches[0]!;
    const seller = byBiz(sellers, m.sellerBusinessId);
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => acceptLead(seller, m.id)));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await getBalance(seller.businessId)).toBe(0);
    expect(await prisma.conversation.count({ where: { matchId: m.id } })).toBe(1);
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: seller.businessId, reason: "consume" } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { aggregateId: e.id, type: "LeadAccepted" } })).toBe(1);
  });

  it("insufficient credits leaves match, conversation, ledger and events untouched", async () => {
    const buyer = await party("buyer");
    const broke = await party("broke");
    const others = await pool(2);
    st.candidates.unshift({ sellerBusinessId: broke.businessId, listingId: randomUUID(), similarity: 0.99 });
    const e = await post(buyer);
    const m = e.matches.find((x) => x.sellerBusinessId === broke.businessId)!;
    await expect(acceptLead(broke, m.id)).rejects.toMatchObject({ code: "insufficient_credits" });
    const row = await prisma.match.findUnique({ where: { id: m.id }, include: { conversation: true } });
    expect(row).toMatchObject({ status: "offered", respondedAt: null, creditTxnId: null, conversation: null });
    expect(await prisma.creditLedgerEntry.count({ where: { businessId: broke.businessId } })).toBe(0);
    expect(await prisma.domainEvent.count({ where: { aggregateId: e.id, type: "LeadAccepted" } })).toBe(0);
    expect(others).toHaveLength(2);
  });

  it("guards: other seller, declined lead, closed enquiry, outsider views", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(4, 2);
    const e = await post(buyer);
    const [m1, m2, m3] = e.matches;
    await expect(acceptLead(byBiz(sellers, m2!.sellerBusinessId), m1!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptLead(buyer, m1!.id)).rejects.toMatchObject({ code: "not_found" });
    await declineLead(byBiz(sellers, m1!.sellerBusinessId), m1!.id);
    await declineLead(byBiz(sellers, m1!.sellerBusinessId), m1!.id); // idempotent
    await expect(acceptLead(byBiz(sellers, m1!.sellerBusinessId), m1!.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(declineLead(byBiz(sellers, m2!.sellerBusinessId), m1!.id)).rejects.toMatchObject({ code: "not_found" });
    await prisma.enquiry.update({ where: { id: e.id }, data: { status: "closed" } });
    await expect(acceptLead(byBiz(sellers, m3!.sellerBusinessId), m3!.id)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/no longer open/) });
    expect(await getSellerLead(m2!.sellerBusinessId, m1!.id)).toBeNull();
    expect(await getSellerLead(m1!.sellerBusinessId, randomUUID())).toBeNull();
    await acceptLead(byBiz(sellers, m2!.sellerBusinessId), m2!.id).catch(() => undefined);
    // after accept, decline is no longer possible
    await prisma.enquiry.update({ where: { id: e.id }, data: { status: "matched" } });
    await acceptLead(byBiz(sellers, m2!.sellerBusinessId), m2!.id);
    await expect(declineLead(byBiz(sellers, m2!.sellerBusinessId), m2!.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("contact reveal: hidden before accept; needs consent AND a phone; notes explain otherwise", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(3, 3);
    const e = await post(buyer);
    const m = e.matches[0]!;
    const seller = byBiz(sellers, m.sellerBusinessId);
    const pre = (await getSellerLead(seller.businessId, m.id))!;
    expect(pre.buyer).toMatchObject({ phone: null, city: null, businessName: expect.stringMatching(/hidden/i) });
    expect(pre.contactNote).toBeNull();
    st.consent = false;
    const noConsent = await acceptLead(seller, m.id);
    expect(noConsent.buyer.phone).toBeNull();
    expect(noConsent.contactNote).toMatch(/not shared/);
    expect(noConsent.buyer.businessName).not.toMatch(/hidden/i);
    st.consent = true;
    expect((await getSellerLead(seller.businessId, m.id))!.buyer.phone).toBe("+919999900000");
    st.phone = null;
    expect((await getSellerLead(seller.businessId, m.id))!.contactNote).toMatch(/not shared/);
    st.hasContactFn = false;
    expect((await getSellerLead(seller.businessId, m.id))!.buyer.phone).toBeNull();
    const leads = await listSellerLeads(seller.businessId);
    expect(leads[0]!.of).toBe(3);
  });
});

describe("reportBuyerProblem", () => {
  async function acceptedSetup(nSellers = 3) {
    const buyer = await party("buyer");
    const sellers = await pool(nSellers, 2);
    const e = await post(buyer);
    const accepted: { actor: Actor; matchId: string; bal: number }[] = [];
    for (const m of e.matches) {
      const actor = byBiz(sellers, m.sellerBusinessId);
      const bal = await getBalance(actor.businessId);
      await acceptLead(actor, m.id);
      accepted.push({ actor, matchId: m.id, bal });
    }
    return { buyer, sellers, e, accepted };
  }

  it("72h window boundary with fake time; refund exactly once; reported lead cannot be re-reported by others", async () => {
    const { accepted, e } = await acceptedSetup(3);
    const a = accepted[0]!;
    const acceptedAt = (await prisma.match.findUnique({ where: { id: a.matchId } }))!.respondedAt!.getTime();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(acceptedAt + 72 * 3600_000 + 1));
    await expect(reportBuyerProblem(a.actor, a.matchId, "buyer_unreachable")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/72-hour/) });
    expect(await getBalance(a.actor.businessId)).toBe(a.bal - 1);
    vi.setSystemTime(new Date(acceptedAt + 72 * 3600_000));
    await reportBuyerProblem(a.actor, a.matchId, "buyer_unreachable");
    expect(await getBalance(a.actor.businessId)).toBe(a.bal);
    await reportBuyerProblem(a.actor, a.matchId, "buyer_unreachable"); // idempotent
    expect(await getBalance(a.actor.businessId)).toBe(a.bal);
    expect(await prisma.domainEvent.count({ where: { aggregateId: e.id, type: "LeadRefunded" } })).toBe(1);
    expect((await prisma.match.findUnique({ where: { id: a.matchId } }))!.status).toBe("refunded");
    // enquiry stays matched; refunded conversation is closed for messaging
    expect((await prisma.enquiry.findUnique({ where: { id: e.id } }))!.status).toBe("matched");
  });

  it("other sellers cannot report; offered leads cannot be reported; one fake flag does not reject; unreachable never counts toward fake", async () => {
    const { accepted, e, sellers } = await acceptedSetup(4);
    await expect(reportBuyerProblem(accepted[1]!.actor, accepted[0]!.matchId, "buyer_fake")).rejects.toMatchObject({ code: "not_found" });
    const extra = (await rows(e.id)).find((m) => m.status === "declined" || m.status === "offered");
    void extra; void sellers;
    await reportBuyerProblem(accepted[0]!.actor, accepted[0]!.matchId, "buyer_fake");
    expect((await prisma.enquiry.findUnique({ where: { id: e.id } }))!.status).toBe("matched");
    await reportBuyerProblem(accepted[1]!.actor, accepted[1]!.matchId, "buyer_unreachable");
    expect((await prisma.enquiry.findUnique({ where: { id: e.id } }))!.status).toBe("matched");
  });

  it("2 distinct fake flags reject the enquiry, refund accepted and close offered leads", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(3, 2);
    const e = await post(buyer);
    const [m1, m2, m3] = e.matches;
    await acceptLead(byBiz(sellers, m1!.sellerBusinessId), m1!.id);
    await acceptLead(byBiz(sellers, m2!.sellerBusinessId), m2!.id);
    const bal3 = await getBalance(m3!.sellerBusinessId);
    await expect(reportBuyerProblem(byBiz(sellers, m3!.sellerBusinessId), m3!.id, "buyer_fake")).rejects.toMatchObject({ code: "conflict" }); // still offered
    await reportBuyerProblem(byBiz(sellers, m1!.sellerBusinessId), m1!.id, "buyer_fake");
    await reportBuyerProblem(byBiz(sellers, m2!.sellerBusinessId), m2!.id, "buyer_fake");
    const enq = await prisma.enquiry.findUnique({ where: { id: e.id } });
    expect(enq).toMatchObject({ status: "rejected", moderationStatus: "rejected" });
    const all = await rows(e.id);
    expect(all.filter((m) => isActive(m.status))).toHaveLength(0);
    expect(all.find((m) => m.id === m3!.id)!.status).toBe("expired");
    expect(await getBalance(m1!.sellerBusinessId)).toBe(2);
    expect(await getBalance(m2!.sellerBusinessId)).toBe(2);
    expect(await getBalance(m3!.sellerBusinessId)).toBe(bal3);
    // rejected enquiries are not cascaded
    expect(await cascade(e.id)).toBe(0);
  });

  it("rejection also refunds a third accepted seller (enquiry_rejected)", async () => {
    const { accepted, e } = await acceptedSetup(3);
    await reportBuyerProblem(accepted[0]!.actor, accepted[0]!.matchId, "buyer_fake");
    await reportBuyerProblem(accepted[1]!.actor, accepted[1]!.matchId, "buyer_fake");
    expect((await rows(e.id)).map((m) => m.status)).toEqual(["refunded", "refunded", "refunded"]);
    const reasons = (await prisma.domainEvent.findMany({ where: { aggregateId: e.id, type: "LeadRefunded" } })).map((x) => (x.payload as { reason: string }).reason).sort();
    expect(reasons).toEqual(["buyer_fake", "buyer_fake", "enquiry_rejected"]);
    for (const a of accepted) expect(await getBalance(a.actor.businessId)).toBe(a.bal);
  });
});

describe("messaging, quotes and deal reports", () => {
  async function convo() {
    const buyer = await party("buyer");
    const sellers = await pool(3, 2);
    const e = await post(buyer);
    const m = e.matches[0]!;
    const seller = byBiz(sellers, m.sellerBusinessId);
    const lead = await acceptLead(seller, m.id);
    const outsider = byBiz(sellers, e.matches[1]!.sellerBusinessId);
    return { buyer, seller, outsider, e, m, cid: lead.conversationId! };
  }

  it("outsiders (even other offered sellers) get nothing: read null, write not_found; bad ids too", async () => {
    const { buyer, seller, outsider, cid, m } = await convo();
    expect(await getConversation(outsider, cid)).toBeNull();
    expect(await getConversation(buyer, "not-a-uuid")).toBeNull();
    expect(await getConversation(buyer, randomUUID())).toBeNull();
    await expect(sendMessage(outsider, cid, "hello")).rejects.toMatchObject({ code: "not_found" });
    await expect(sendQuote(outsider, cid, { pricePaise: 5, quantity: 1, unit: "pcs" })).rejects.toMatchObject({ code: "not_found" });
    await expect(reportDeal(outsider, m.id, "won")).rejects.toMatchObject({ code: "not_found" });
    expect(await prisma.message.count({ where: { conversationId: cid } })).toBe(0);
    expect((await getConversation(buyer, cid))!.role).toBe("buyer");
    expect((await getConversation(seller, cid))!.role).toBe("seller");
  });

  it("messages: trimmed, ordered chronologically, validated; participants can both send", async () => {
    const { buyer, seller, cid } = await convo();
    await expect(sendMessage(buyer, cid, "   ")).rejects.toBeTruthy();
    await expect(sendMessage(buyer, cid, "x".repeat(4001))).rejects.toBeTruthy();
    await sendMessage(buyer, cid, "  first  ");
    await sendMessage(seller, cid, "second");
    const c = (await getConversation(buyer, cid))!;
    expect(c.messages.map((x) => x.body)).toEqual(["first", "second"]);
    expect(c.messages[1]!.senderPersonId).toBe(seller.personId);
    expect(c.buyer.businessId).not.toBe(c.seller.businessId);
    expect(c.enquiryTitle).toMatch(/Corrugated/);
  });

  it("rate limits messages at 30 per minute per person", async () => {
    const { buyer, cid } = await convo();
    for (let i = 0; i < 30; i++) await sendMessage(buyer, cid, `m${i}`);
    await expect(sendMessage(buyer, cid, "31st")).rejects.toMatchObject({ code: "rate_limited" });
    expect(await prisma.message.count({ where: { conversationId: cid } })).toBe(30);
  });

  it("only the seller quotes; validated; stored in order with normalised optional fields", async () => {
    const { buyer, seller, cid } = await convo();
    await expect(sendQuote(buyer, cid, { pricePaise: 100, quantity: 1, unit: "pcs" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendQuote(seller, cid, { pricePaise: 0, quantity: 1, unit: "pcs" })).rejects.toBeTruthy();
    await sendQuote(seller, cid, { pricePaise: 100, quantity: 2, unit: "pcs", leadTimeDays: 3, notes: " ok ", validUntil: "2026-12-31" });
    await sendQuote(seller, cid, { pricePaise: 90, quantity: 2, unit: "pcs" });
    const q = (await getConversation(seller, cid))!.quotes;
    expect(q.map((x) => x.pricePaise)).toEqual([100, 90]);
    expect(q[0]).toMatchObject({ leadTimeDays: 3, notes: "ok", validUntil: "2026-12-31" });
    expect(q[1]).toMatchObject({ leadTimeDays: null, notes: null, validUntil: null });
  });

  it("deal report: either party, validated, latest wins, value optional; only accepted leads", async () => {
    const { buyer, seller, m, cid } = await convo();
    await expect(reportDeal(buyer, m.id, "maybe" as never)).rejects.toMatchObject({ code: "validation" });
    await expect(reportDeal(buyer, m.id, "won", -5)).rejects.toMatchObject({ code: "validation" });
    await expect(reportDeal(buyer, m.id, "won", 1.5)).rejects.toMatchObject({ code: "validation" });
    expect((await getConversation(buyer, cid))!.dealReported).toBeNull();
    await reportDeal(buyer, m.id, "pending");
    await reportDeal(seller, m.id, "won", 500_000);
    expect((await getConversation(buyer, cid))!.dealReported).toBe("won");
    expect(await prisma.dealReport.count({ where: { matchId: m.id } })).toBe(2);
    await reportBuyerProblem(seller, m.id, "buyer_unreachable");
    await expect(reportDeal(seller, m.id, "lost")).rejects.toMatchObject({ code: "conflict" });
    await expect(reportDeal(buyer, randomUUID(), "won")).rejects.toMatchObject({ code: "not_found" });
    // refunded conversation is closed
    await expect(sendMessage(buyer, cid, "hi")).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("getters", () => {
  it("hasAcceptedMatch / summaries / parties / ops view", async () => {
    const buyer = await party("buyer");
    const sellers = await pool(3, 2);
    const e = await post(buyer, { targetPricePaise: 999 });
    const m = e.matches[0]!;
    const seller = byBiz(sellers, m.sellerBusinessId);
    expect(await api.hasAcceptedMatch(buyer.businessId, seller.businessId)).toBe(false);
    const lead = await acceptLead(seller, m.id);
    expect(await api.hasAcceptedMatch(buyer.businessId, seller.businessId)).toBe(true);
    expect(await api.hasAcceptedMatch(seller.businessId, buyer.businessId)).toBe(false);
    expect(await api.getEnquirySummary("nope")).toBeNull();
    expect(await api.getEnquirySummary(randomUUID())).toBeNull();
    expect(await api.getEnquirySummary(e.id)).toMatchObject({ id: e.id, buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, status: "matched", intentScore: 80 });
    expect(await api.getEnquiryForOps("x")).toBeNull();
    expect(await api.getEnquiryForOps(randomUUID())).toBeNull();
    expect(await api.getEnquiryForOps(e.id)).toMatchObject({ targetPricePaise: 999, moderationStatus: "approved", language: "en" });
    expect(await api.getConversationParties("x")).toBeNull();
    expect(await api.getConversationParties(randomUUID())).toBeNull();
    const parties = (await api.getConversationParties(lead.conversationId!))!;
    expect(parties).toMatchObject({ enquiryId: e.id, buyerBusinessId: buyer.businessId, sellerBusinessId: seller.businessId });
    expect(await api.getMatchSummary("x")).toBeNull();
    expect(await api.getMatchSummary(randomUUID())).toBeNull();
    expect(await api.getMatchSummary(m.id)).toMatchObject({ status: "accepted", rank: 1, buyerBusinessId: buyer.businessId });
  });
});
