// RFQ publish and quote acceptance consult @cnote/approvals (docs/design/buyer-approvals.md): held, then resumed from the events.
import { decide, savePolicy, setSpendLimit } from "@cnote/approvals";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/ai", () => ({
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false }),
  embed: async () => ({ vectors: [Array.from({ length: 256 }, (_, i) => (i % 5) / 5)], version: "test" }),
  scoreIntent: async () => ({ score: 80, reasons: ["Specific quantity"], decisionId: "d", confidence: 0.9, needsReview: false }),
}));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  listCategories: async () => [],
  getListing: async () => null,
  getPublicListing: async () => null,
  findSellerCandidates: async () => [],
}));

import { createEnquiry, decideQuote, getQuoteComparison, rfqEstimatePaise, sendQuote } from "../src";
import { worker } from "../src/worker";

const tag = `appr-${Date.now()}`;
const bizIds: string[] = [];
const personIds: string[] = [];
const enquiryIds: string[] = [];
let b: { businessId: string; owner: string; requester: string; approver: string; viewer: string };
let seller: { personId: string; businessId: string };

async function person(name: string, businessId: string, role: string) {
  const p = await prisma.person.create({ data: { name: `${tag}-${name}`, email: `${randomUUID()}@example.test` } });
  await prisma.businessMember.create({ data: { businessId, personId: p.id, role: role as "owner" } });
  personIds.push(p.id);
  return p.id;
}

const ev = (type: "ApprovalApproved" | "ApprovalRejected", payload: Record<string, unknown>) => ({ id: 1, type, version: 1, aggregateType: "approval", aggregateId: String(payload.requestId), occurredAt: "", payload }) as never;
const eventsOf = async (type: string, requestId: string) =>
  (await prisma.domainEvent.findMany({ where: { type }, orderBy: { id: "asc" } })).map((e) => e.payload as Record<string, unknown>).filter((p) => p.requestId === requestId);

beforeAll(async () => {
  const biz = await prisma.business.create({ data: { name: `${tag}-buyer`, city: "Pune" } });
  bizIds.push(biz.id);
  const sb = await prisma.business.create({ data: { name: `${tag}-seller`, city: "Pune" } });
  bizIds.push(sb.id);
  const sp = await prisma.person.create({ data: { name: `${tag}-seller` } });
  personIds.push(sp.id);
  await prisma.businessMember.create({ data: { businessId: sb.id, personId: sp.id } });
  seller = { personId: sp.id, businessId: sb.id };
  b = {
    businessId: biz.id,
    owner: await person("owner", biz.id, "owner"),
    requester: await person("requester", biz.id, "requester"),
    approver: await person("approver", biz.id, "approver"),
    viewer: await person("viewer", biz.id, "viewer"),
  };
});

afterAll(async () => {
  const convos = (await prisma.conversation.findMany({ where: { match: { enquiryId: { in: enquiryIds } } }, select: { id: true } })).map((c) => c.id);
  const matchIds = (await prisma.match.findMany({ where: { enquiryId: { in: enquiryIds } }, select: { id: true } })).map((m) => m.id);
  await prisma.order.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.quote.deleteMany({ where: { conversationId: { in: convos } } });
  await prisma.dealReport.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convos } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.spendRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.memberSpendLimit.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.approvalPolicy.deleteMany({ where: { businessId: { in: bizIds } } });
  const reqs = (await prisma.approvalRequest.findMany({ where: { businessId: { in: bizIds } }, select: { id: true } })).map((r) => r.id);
  await prisma.approvalDecision.deleteMany({ where: { requestId: { in: reqs } } });
  await prisma.approvalRequest.deleteMany({ where: { id: { in: reqs } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${[...enquiryIds, ...convos, ...reqs]}) OR payload->>'businessId' = ANY(${bizIds})`;
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

const rfq = { title: "Cotton yarn 40s", requirement: "Need 500 kg combed cotton yarn, 40s count, monthly", quantity: 500, quantityUnit: "kg", targetPricePaise: 30_000 };

describe("roles", () => {
  it("only roles with rfq.create can publish a requirement", async () => {
    await expect(createEnquiry({ personId: b.viewer, businessId: b.businessId }, rfq)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createEnquiry({ personId: b.approver, businessId: b.businessId }, rfq)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("estimates the RFQ value from the target price (or budget) times quantity", () => {
    expect(rfqEstimatePaise({ targetPricePaise: 30_000, quantity: 500 })).toBe(15_000_000);
    expect(rfqEstimatePaise({ budgetMaxPaise: 100, quantity: null })).toBe(100);
    expect(rfqEstimatePaise({})).toBe(0);
  });
});

describe("RFQ publish approval", () => {
  it("holds a matching RFQ in pending_approval, then matches it when approved (and only once)", async () => {
    await savePolicy(b.businessId, b.owner, { name: "RFQs over 1 lakh", action: "rfq_publish", minAmountPaise: 10_000_000, levels: [{ role: "approver" }] });
    const small = await createEnquiry({ personId: b.requester, businessId: b.businessId }, { ...rfq, quantity: 10 });
    enquiryIds.push(small.id);
    expect(small.status).not.toBe("pending_approval");

    const held = await createEnquiry({ personId: b.requester, businessId: b.businessId }, rfq);
    enquiryIds.push(held.id);
    expect(held.status).toBe("pending_approval");
    expect(held.matches).toEqual([]);
    const request = await prisma.approvalRequest.findFirstOrThrow({ where: { subjectId: held.id } });
    expect(request).toMatchObject({ action: "rfq_publish", status: "pending", subjectType: "enquiry" });

    await decide({ requestId: request.id, deciderId: b.approver, decision: "approve", comment: "go" });
    const [approved] = await eventsOf("ApprovalApproved", request.id);
    await worker.handlers.ApprovalApproved!(ev("ApprovalApproved", approved!));
    // no candidates in this fixture: resuming ran matching, which ends "unmatched" (it left "pending_approval")
    expect((await prisma.enquiry.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("unmatched");
    await worker.handlers.ApprovalApproved!(ev("ApprovalApproved", approved!)); // redelivery is harmless
    expect((await prisma.enquiry.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("unmatched");
  });

  it("closes the requirement when the approval is rejected", async () => {
    const held = await createEnquiry({ personId: b.requester, businessId: b.businessId }, { ...rfq, title: "Cotton yarn 60s" });
    enquiryIds.push(held.id);
    expect(held.status).toBe("pending_approval");
    const request = await prisma.approvalRequest.findFirstOrThrow({ where: { subjectId: held.id } });
    await decide({ requestId: request.id, deciderId: b.owner, decision: "reject", comment: "Not this quarter" });
    const [rejected] = await eventsOf("ApprovalRejected", request.id);
    await worker.handlers.ApprovalRejected!(ev("ApprovalRejected", rejected!));
    expect((await prisma.enquiry.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("closed");
  });
});

describe("quote acceptance approval", () => {
  async function quoted(pricePaise: number, quantity: number) {
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: b.businessId, buyerPersonId: b.requester, title: `Quote ${randomUUID().slice(0, 4)}`, requirement: "Need things", quantity, status: "matched" } });
    const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: seller.businessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date(Date.now() + 3600_000) } });
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    enquiryIds.push(e.id);
    const { quoteId } = await sendQuote(seller, c.id, { pricePaise, quantity, unit: "kg" });
    return { enquiryId: e.id, matchId: m.id, quoteId };
  }

  it("holds acceptance above the threshold and completes it (order + spend) once approved", async () => {
    await savePolicy(b.businessId, b.owner, { name: "Quotes over 50k", action: "quote_accept", minAmountPaise: 5_000_000, levels: [{ role: "approver" }] });
    const q = await quoted(20_000, 500); // ₹1,00,000
    const res = await decideQuote({ personId: b.requester, businessId: b.businessId }, q.quoteId, "accept");
    expect(res).toMatchObject({ status: "pending_approval" });
    expect(await prisma.dealReport.count({ where: { matchId: q.matchId } })).toBe(0);
    expect(await prisma.order.count({ where: { matchId: q.matchId } })).toBe(0);

    const cmp = await getQuoteComparison({ personId: b.requester, businessId: b.businessId }, q.enquiryId);
    expect(cmp!.rows[0]!.approval).toMatchObject({ status: "pending", requestId: res.requestId });
    // asking again does not raise a second request
    expect(await decideQuote({ personId: b.requester, businessId: b.businessId }, q.quoteId, "accept")).toMatchObject({ status: "pending_approval", requestId: res.requestId });

    await decide({ requestId: res.requestId!, deciderId: b.approver, decision: "approve" });
    const [approved] = await eventsOf("ApprovalApproved", res.requestId!);
    await worker.handlers.ApprovalApproved!(ev("ApprovalApproved", approved!));
    await worker.handlers.ApprovalApproved!(ev("ApprovalApproved", approved!)); // redelivery
    expect(await prisma.dealReport.count({ where: { matchId: q.matchId, outcome: "won" } })).toBe(1);
    expect(await prisma.order.count({ where: { matchId: q.matchId } })).toBe(1);
    expect((await prisma.spendRecord.findFirstOrThrow({ where: { subjectId: q.quoteId } }))).toMatchObject({ personId: b.requester, amountPaise: 10_000_000n });
    // the approved request now lets a direct retry through as a no-op accept
    expect(await decideQuote({ personId: b.requester, businessId: b.businessId }, q.quoteId, "accept")).toMatchObject({ status: "accepted" });
    expect(await prisma.dealReport.count({ where: { matchId: q.matchId, outcome: "won" } })).toBe(1);
  });

  it("accepts straight away below the threshold, never gates a decline, and refuses viewers", async () => {
    const small = await quoted(1_000, 10);
    expect(await decideQuote({ personId: b.requester, businessId: b.businessId }, small.quoteId, "accept")).toMatchObject({ status: "accepted", requestId: null });
    expect(await prisma.order.count({ where: { matchId: small.matchId } })).toBe(1);

    const big = await quoted(20_000, 500);
    expect(await decideQuote({ personId: b.requester, businessId: b.businessId }, big.quoteId, "decline")).toMatchObject({ status: "declined" });
    expect(await prisma.approvalRequest.count({ where: { subjectId: big.quoteId } })).toBe(0);

    const other = await quoted(1_000, 10);
    await expect(decideQuote({ personId: b.viewer, businessId: b.businessId }, other.quoteId, "accept")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a rejected approval keeps the quote unaccepted", async () => {
    const q = await quoted(20_000, 500);
    const res = await decideQuote({ personId: b.requester, businessId: b.businessId }, q.quoteId, "accept");
    await decide({ requestId: res.requestId!, deciderId: b.owner, decision: "reject", comment: "Too expensive" });
    await expect(decideQuote({ personId: b.requester, businessId: b.businessId }, q.quoteId, "accept")).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.order.count({ where: { matchId: q.matchId } })).toBe(0);
  });

  it("the member's monthly spend limit escalates an otherwise-unruled acceptance", async () => {
    const t = await person("limited", b.businessId, "requester");
    await setSpendLimit({ businessId: b.businessId, actorPersonId: b.owner, personId: t, monthlyCapPaise: 50_000 });
    const q = await quoted(1_000, 100); // ₹1,000: below the policy threshold, above the ₹500 cap
    const res = await decideQuote({ personId: t, businessId: b.businessId }, q.quoteId, "accept");
    expect(res.status).toBe("pending_approval");
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: res.requestId! } })).reason).toBe("spend_limit");
  });
});
