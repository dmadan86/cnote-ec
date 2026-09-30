import type { DomainEvent } from "@cnote/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/templates", () => ({ defineTemplates: () => {}, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { COPY, LOCALES } from "../src/copy-phase23";
import { getKind, kindsFor, templateDefinitions } from "../src/kinds";
import { PHASE23_KINDS } from "../src/kinds-phase23";
import { prismaDirectory, setPartyResolvers, type Directory } from "../src/recipients";
import { CATEGORIES } from "../src/types";

const SB = "sb", BB = "bb";
const dir = (over: Partial<Directory> = {}): Directory => ({
  businessMembers: async (b, o) => (b === SB ? (o?.ownersOnly ? ["s-owner"] : ["s1", "s2"]) : b === BB ? (o?.ownersOnly ? ["b-owner"] : ["b1"]) : []),
  businessName: async () => "X", enquiry: async () => null, conversation: async () => null, listingTitle: async () => null, review: async () => null, comment: async () => null, contact: async () => null,
  orderParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB }),
  ondcOrderSeller: async () => SB,
  creditApplicationBusiness: async () => SB,
  negotiationParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB }),
  ...over,
});
const ev = (type: string, payload: unknown): DomainEvent => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: "" }) as never;
const run = (key: string, event: DomainEvent, d: Directory = dir()) => getKind(key)!.resolve(event as never, d);
const ids = (rs: { personId: string }[]) => rs.map((r) => r.personId).sort();

interface Row { d?: Directory; key: string; event: DomainEvent; people: string[]; app?: string; vars?: Record<string, unknown>; href?: string }
const NEG = { negotiationId: "n1" };
const TABLE: Row[] = [
  { key: "ads.campaign_approved", event: ev("AdCampaignReviewed", { campaignId: "c1", sellerBusinessId: SB, decision: "approved", reviewedBy: "staff" }), people: ["s1", "s2"], href: "/ads/c1" },
  { key: "ads.campaign_rejected", event: ev("AdCampaignReviewed", { campaignId: "c1", sellerBusinessId: SB, decision: "rejected", reviewedBy: "staff", note: "Image mismatch" }), people: ["s1", "s2"], vars: { reason: "Image mismatch" } },
  { key: "ads.campaign_rejected", event: ev("AdCampaignReviewed", { campaignId: "c1", sellerBusinessId: SB, decision: "rejected", reviewedBy: "staff", reasonCode: "prohibited_category" }), people: ["s1", "s2"], vars: { reason: "prohibited category" } },
  { key: "ads.campaign_rejected", event: ev("AdCampaignReviewed", { campaignId: "c1", sellerBusinessId: SB, decision: "rejected", reviewedBy: "staff" }), people: ["s1", "s2"], vars: { reason: "see the campaign for details" } },
  { key: "ads.campaign_paused_wallet", event: ev("AdCampaignStatusChanged", { campaignId: "c1", sellerBusinessId: SB, from: "active", to: "paused", cause: "wallet" }), people: ["s1", "s2"], href: "/ads/c1" },
  { key: "ads.campaign_paused_eligibility", event: ev("AdCampaignStatusChanged", { campaignId: "c1", sellerBusinessId: SB, from: "active", to: "paused", cause: "eligibility" }), people: ["s1", "s2"] },
  { key: "ads.campaign_suspended", event: ev("AdCampaignStatusChanged", { campaignId: "c1", sellerBusinessId: SB, from: "active", to: "suspended", cause: "staff" }), people: ["s1", "s2"] },
  { key: "ads.budget_exhausted", event: ev("AdBudgetExhausted", { campaignId: "c1", sellerBusinessId: SB, istDate: "2026-09-30", spentPaise: 50000, dailyBudgetPaise: 50000 }), people: ["s1", "s2"], vars: { spent: "₹500", dailyBudget: "₹500", date: "2026-09-30" } },
  { key: "ads.wallet_low", event: ev("AdWalletLow", { businessId: SB, balancePaise: 12345600, thresholdPaise: 50000 }), people: ["s-owner"], vars: { balance: "₹1,23,456", threshold: "₹500" }, href: "/ads" },
  { key: "a2a.confirmation_needed", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: null, pricePaise: 12000 }), people: ["b1", "s1", "s2"], vars: { price: "₹120" } },
  { key: "a2a.agreed_auto", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: "auto", pricePaise: 12000 }), people: ["b1", "s1", "s2"], vars: { price: "₹120" } },
  { key: "a2a.ended", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "expired", confirmedBy: null, pricePaise: null }), people: ["b1", "s1", "s2"] },
  { key: "a2a.ended", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "rejected", confirmedBy: null, pricePaise: null }), people: ["b1", "s1", "s2"] },
  { key: "a2a.mandate_suspended", event: ev("AgentMandateSuspended", { businessId: SB, mandateId: "m1", side: "seller", scope: "mandate" }), people: ["s1", "s2"], app: "seller", href: "/agents" },
  { key: "a2a.mandate_suspended", event: ev("AgentMandateSuspended", { businessId: BB, mandateId: "m2", side: "buyer", scope: "mandate" }), people: ["b1"], app: "web", href: "/buyer/agents" },
  { key: "a2a.offer_awaiting", d: dir({ negotiationParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB, awaitingReplyBusinessId: SB }) }), event: ev("AgentOfferMade", { ...NEG, round: 1, by: "buyer", pricePaise: 12000, quantity: 5 }), people: ["s1", "s2"], app: "seller", vars: { price: "₹120", quantity: 5 } },
  { key: "escrow.funded", event: ev("EscrowFunded", { escrowId: "e", orderId: "o1", amountPaise: 2500000, partnerRef: "p" }), people: ["s1", "s2"], app: "seller", vars: { amount: "₹25,000" }, href: "/orders/o1" },
  { key: "escrow.released", event: ev("EscrowReleased", { escrowId: "e", orderId: "o1", sellerBusinessId: SB, amountPaise: 2475000, feePaise: 25000, cause: "buyer_accepted" }), people: ["s1", "s2"], vars: { amount: "₹24,750", fee: "₹250" }, href: "/orders/o1" },
  { key: "escrow.payout_settled", event: ev("PayoutSettled", { payoutId: "p", escrowId: "e", sellerBusinessId: SB, amountPaise: 2475000, partnerRef: "r", latencyMs: 1 }), people: ["s1", "s2"], vars: { amount: "₹24,750" }, href: "/orders" },
  { key: "escrow.refunded", event: ev("EscrowRefunded", { escrowId: "e", orderId: "o1", buyerBusinessId: BB, amountPaise: 2500000, cause: "cancelled" }), people: ["b1"], app: "web", vars: { amount: "₹25,000" }, href: "/buyer/orders/o1" },
  { key: "escrow.frozen", event: ev("EscrowFrozen", { escrowId: "e", orderId: "o1", disputeId: "d1" }), people: ["b1", "s1", "s2"] },
  { key: "dispute.opened", event: ev("DisputeOpened", { disputeId: "d1", orderId: "o1", openedByBusinessId: BB, againstBusinessId: SB, type: "not_received", amountPaise: 500000 }), people: ["s1", "s2"], app: "seller", vars: { amount: "₹5,000" }, href: "/disputes/d1" },
  { key: "dispute.opened", event: ev("DisputeOpened", { disputeId: "d1", orderId: "o1", openedByBusinessId: SB, againstBusinessId: BB, type: "x", amountPaise: null }), people: ["b1"], app: "web", vars: { amount: "not stated" }, href: "/buyer/disputes/d1" },
  { key: "dispute.brief_ready", event: ev("DisputeBriefReady", { disputeId: "d1", orderId: "o1", recommendation: "refund", confidence: 0.9, autoResolvable: false }), people: ["b1", "s1", "s2"] },
  { key: "dispute.resolved", event: ev("DisputeResolved", { disputeId: "d1", orderId: "o1", outcome: "split", refundPaise: 500000, releasePaise: 2000000, decidedBy: "staff", faultBusinessId: SB }), people: ["b1", "s1", "s2"], vars: { refund: "₹5,000", release: "₹20,000" } },
  { key: "credit.offer_received", event: ev("CreditOfferReceived", { applicationId: "a1", offerId: "o", amountPaise: 10000000, aprBps: 1850, tenorDays: 60 }), people: ["s-owner"], vars: { amount: "₹1,00,000", tenor: 60, apr: 18.5 }, href: "/credit" },
  { key: "credit.disbursed", event: ev("CreditDisbursed", { loanId: "l", applicationId: "a", businessId: SB, amountPaise: 10000000, orderId: null }), people: ["s-owner"], vars: { amount: "₹1,00,000" } },
  { key: "credit.overdue", event: ev("CreditOverdue", { loanId: "l", businessId: SB, dpd: 3 }), people: ["s-owner"], vars: { dpd: 3 } },
  { key: "credit.closed", event: ev("CreditClosed", { loanId: "l", businessId: SB, status: "repaid" }), people: ["s-owner"] },
  { key: "credit.cancelled", event: ev("CreditCancelled", { loanId: "l", applicationId: "a", businessId: SB, reason: "cooling_off" }), people: ["s-owner"] },
  { key: "quality.check_completed", event: ev("QualityCheckCompleted", { checkId: "q", orderId: "o1", sellerBusinessId: SB, categorySlug: "c", verdict: "inconsistent", confidence: 0.8 }), people: ["s1", "s2"], href: "/orders/o1" },
  { key: "ondc.order_received", event: ev("OndcOrderReceived", { ondcOrderId: "x", orderId: null, sellerBusinessId: SB, bapId: "b", transactionId: "t" }), people: ["s1", "s2"], href: "/ondc/orders" },
  { key: "ondc.issue_received", event: ev("OndcIssueReceived", { issueId: "i", ondcOrderId: "x", disputeId: "d9" }), people: ["s1", "s2"], href: "/disputes/d9" },
  { key: "ondc.issue_received", event: ev("OndcIssueReceived", { issueId: "i", ondcOrderId: "x", disputeId: null }), people: ["s1", "s2"], href: "/ondc/orders" },
  { key: "negotiation.draft_ready", event: ev("QuoteDraftGenerated", { draftId: "d", matchId: "m", sellerBusinessId: SB, pricePaise: 12050, confidence: 0.7 }), people: ["s1", "s2"], vars: { price: "₹120.5" }, href: "/leads" },
  { key: "negotiation.draft_ready", event: ev("QuoteDraftGenerated", { draftId: "d", matchId: "m", sellerBusinessId: SB, pricePaise: null, confidence: 0.7 }), people: ["s1", "s2"], vars: { price: "not set" } },
  { key: "order.fulfilment_updated", event: ev("OrderFulfilmentUpdated", { orderId: "o1", buyerBusinessId: BB, sellerBusinessId: SB, stage: "in_transit", note: "  left\nhub " }), people: ["b1"], vars: { note: "left hub" }, href: "/buyer/orders/o1" },
];
const NONE: { key: string; event: DomainEvent; d?: Directory; note: string }[] = [
  { key: "ads.campaign_approved", event: ev("AdCampaignReviewed", { campaignId: "c", sellerBusinessId: SB, decision: "rejected", reviewedBy: "s" }), note: "rejected is a different kind" },
  { key: "ads.campaign_rejected", event: ev("AdCampaignReviewed", { campaignId: "c", sellerBusinessId: SB, decision: "approved", reviewedBy: "s" }), note: "approved" },
  { key: "ads.campaign_paused_wallet", event: ev("AdCampaignStatusChanged", { campaignId: "c", sellerBusinessId: SB, from: "paused", to: "approved", cause: "wallet" }), note: "resumed" },
  { key: "ads.campaign_paused_wallet", event: ev("AdCampaignStatusChanged", { campaignId: "c", sellerBusinessId: SB, from: "active", to: "paused", cause: "seller" }), note: "seller's own pause" },
  { key: "ads.campaign_paused_eligibility", event: ev("AdCampaignStatusChanged", { campaignId: "c", sellerBusinessId: SB, from: "paused", to: "active", cause: "eligibility" }), note: "restored" },
  { key: "ads.campaign_suspended", event: ev("AdCampaignStatusChanged", { campaignId: "c", sellerBusinessId: SB, from: "pending_review", to: "approved", cause: "staff" }), note: "staff approval is AdCampaignReviewed" },
  { key: "ads.campaign_suspended", event: ev("AdCampaignStatusChanged", { campaignId: "c", sellerBusinessId: SB, from: "active", to: "exhausted", cause: "budget" }), note: "budget halts use AdBudgetExhausted" },
  { key: "a2a.confirmation_needed", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: "human", pricePaise: 1 }), note: "already confirmed" },
  { key: "a2a.confirmation_needed", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: null, pricePaise: null }), note: "no price" },
  { key: "a2a.confirmation_needed", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "rejected", confirmedBy: null, pricePaise: null }), note: "rejected" },
  { key: "a2a.confirmation_needed", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: null, pricePaise: 1 }), d: dir({ negotiationParties: async () => null }), note: "unknown negotiation" },
  { key: "a2a.agreed_auto", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: "human", pricePaise: 1 }), note: "human confirmed" },
  { key: "a2a.agreed_auto", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "accepted", confirmedBy: "auto", pricePaise: 1 }), d: dir({ negotiationParties: undefined }), note: "resolver not wired" },
  { key: "a2a.ended", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "withdrawn", confirmedBy: null, pricePaise: null }), note: "withdrawn by a human who knows" },
  { key: "a2a.ended", event: ev("AgentNegotiationClosed", { ...NEG, outcome: "expired", confirmedBy: null, pricePaise: null }), d: dir({ negotiationParties: async () => null }), note: "unknown negotiation" },
  { key: "a2a.offer_awaiting", event: ev("AgentOfferMade", { ...NEG, round: 1, by: "buyer", pricePaise: 1, quantity: 1 }), note: "the other side's agent replies itself" },
  { key: "escrow.funded", event: ev("EscrowFunded", { escrowId: "e", orderId: "o", amountPaise: 1, partnerRef: "p" }), d: dir({ orderParties: async () => null }), note: "order not found" },
  { key: "escrow.frozen", event: ev("EscrowFrozen", { escrowId: "e", orderId: "o", disputeId: "d" }), d: dir({ orderParties: undefined }), note: "resolver not wired" },
  { key: "dispute.brief_ready", event: ev("DisputeBriefReady", { disputeId: "d", orderId: "o", recommendation: "r", confidence: 1, autoResolvable: true }), d: dir({ orderParties: async () => null }), note: "order not found" },
  { key: "credit.offer_received", event: ev("CreditOfferReceived", { applicationId: "a", offerId: "o", amountPaise: 1, aprBps: 1, tenorDays: 1 }), d: dir({ creditApplicationBusiness: async () => null }), note: "unknown application" },
  { key: "credit.overdue", event: ev("CreditOverdue", { loanId: "l", businessId: SB, dpd: 0 }), note: "not yet overdue" },
  { key: "ondc.issue_received", event: ev("OndcIssueReceived", { issueId: "i", ondcOrderId: "x", disputeId: null }), d: dir({ ondcOrderSeller: async () => null }), note: "unknown ONDC order" },
];

describe("phase 2/3 kinds registry", () => {
  it("every kind has a unique key, existing non-marketing category, covered variables and is table-tested", () => {
    const covered = new Set(TABLE.map((r) => r.key));
    expect(new Set(PHASE23_KINDS.map((k) => k.key)).size).toBe(PHASE23_KINDS.length);
    for (const k of PHASE23_KINDS) {
      expect(CATEGORIES).toContain(k.category);
      expect(["marketing", "security"]).not.toContain(k.category);
      expect(covered, k.key).toContain(k.key);
      expect(getKind(k.key)).toBe(k);
      const names = new Set(k.variables.map((x) => x.name));
      const texts = [k.defaults.in_app, k.defaults.email, ...Object.values(k.localized ?? {}).flatMap((l) => [l.in_app, l.email])];
      for (const c of texts) for (const m of `${c?.subject ?? ""} ${c?.body ?? ""}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) expect(names, `${k.key} uses {{${m[1]}}}`).toContain(m[1]);
    }
  });
  it("localized copy: all 7 other locales, same placeholders as English, no empty strings", () => {
    expect(Object.keys(COPY).sort()).toEqual(PHASE23_KINDS.map((k) => k.key).sort());
    const ph = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const k of PHASE23_KINDS) {
      expect(Object.keys(k.localized!).sort()).toEqual([...LOCALES].sort());
      for (const l of LOCALES) {
        const c = k.localized![l]!.in_app!;
        expect(c.subject!.length, `${k.key}/${l}`).toBeGreaterThan(3);
        expect(ph(c.body), `${k.key}/${l}`).toEqual(ph(k.defaults.in_app.body));
        expect(c.body).not.toBe(k.defaults.in_app.body);
      }
      expect(k.localized!.hi!.email).toBeDefined();
    }
  });
  it("template definitions carry the localized copy and stay transactional", () => {
    const defs = templateDefinitions().filter((d) => COPY[d.key]);
    expect(defs).toHaveLength(PHASE23_KINDS.length);
    for (const d of defs) {
      expect(d.category).toBe("transactional");
      expect(Object.keys(d.localized!).sort()).toEqual([...LOCALES].sort());
      expect(d.localized!.hi!.email).toBeDefined();
      expect(d.localized!.kn!.email).toBeUndefined();
    }
  });
  it("events with several kinds", () => {
    expect(kindsFor("AgentNegotiationClosed").map((k) => k.key).sort()).toEqual(["a2a.agreed_auto", "a2a.confirmation_needed", "a2a.ended"]);
    expect(kindsFor("AdCampaignStatusChanged")).toHaveLength(3);
    expect(kindsFor("AdCampaignReviewed")).toHaveLength(2);
  });
});

describe("phase 2/3 event → recipients", () => {
  it.each(TABLE.map((r, i) => [`${r.key} #${i}`, r] as const))("%s", async (_n, row) => {
    const out = await run(row.key, row.event, row.d);
    expect(ids(out)).toEqual([...row.people].sort());
    expect(new Set(out.map((r) => r.personId)).size).toBe(out.length);
    for (const r of out) {
      if (row.app) expect(r.app ?? getKind(row.key)!.app).toBe(row.app);
      if (row.vars) expect(r.vars).toMatchObject(row.vars);
      if (row.href) expect(r.href).toBe(row.href);
      expect(r.href.startsWith("/")).toBe(true);
    }
  });
  it.each(NONE.map((r) => [`${r.key}: ${r.note}`, r] as const))("no recipients: %s", async (_n, row) => {
    expect(await run(row.key, row.event, row.d)).toEqual([]);
  });
  it("two-sided kinds address each party in its own app and link", async () => {
    const out = await run("dispute.resolved", TABLE.find((r) => r.key === "dispute.resolved")!.event);
    const by = Object.fromEntries(out.map((r) => [r.personId, r]));
    expect(by.b1).toMatchObject({ app: "web", businessId: BB, href: "/buyer/disputes/d1" });
    expect(by.s1).toMatchObject({ app: "seller", businessId: SB, href: "/disputes/d1" });
  });
  it("a2a confirmation targets only the businesses still to confirm", async () => {
    const d = dir({ negotiationParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB, awaitingConfirmation: [BB] }) });
    const out = await run("a2a.confirmation_needed", TABLE.find((r) => r.key === "a2a.confirmation_needed")!.event, d);
    expect(ids(out)).toEqual(["b1"]);
    expect(out[0]).toMatchObject({ app: "web", href: "/buyer/agents/negotiations/n1" });
  });
  it("a2a offers notify only the human principal who must answer", async () => {
    const e = ev("AgentOfferMade", { ...NEG, round: 2, by: "seller", pricePaise: 12000, quantity: 500 });
    const buyerHuman = dir({ negotiationParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB, awaitingReplyBusinessId: BB }) });
    const out = await run("a2a.offer_awaiting", e, buyerHuman);
    expect(ids(out)).toEqual(["b1"]);
    expect(out[0]).toMatchObject({ app: "web", vars: { price: "₹120", quantity: 500 }, href: "/buyer/agents/negotiations/n1" });
    const sellerHuman = dir({ negotiationParties: async () => ({ buyerBusinessId: BB, sellerBusinessId: SB, awaitingReplyBusinessId: SB }) });
    expect(ids(await run("a2a.offer_awaiting", e, sellerHuman))).toEqual(["s1", "s2"]);
    expect((await run("a2a.offer_awaiting", e, sellerHuman))[0]!.href).toBe("/agents/negotiations/n1");
  });
  it("dispute.opened without an order lookup defaults to the seller app", async () => {
    const e = ev("DisputeOpened", { disputeId: "d1", orderId: "o1", openedByBusinessId: BB, againstBusinessId: SB, type: "t", amountPaise: 100 });
    const out = await run("dispute.opened", e, dir({ orderParties: undefined }));
    expect(out[0]).toMatchObject({ app: "seller", href: "/disputes/d1" });
  });
  it("no counterparty identity or fault leaks into variables (ADR-010)", async () => {
    for (const r of TABLE) for (const rec of await run(r.key, r.event, r.d)) {
      const s = JSON.stringify(rec.vars);
      expect(s).not.toMatch(/faultBusinessId|reviewedBy|recommendation|confidence/);
      expect(s).not.toContain(BB === rec.businessId ? SB : BB);
    }
  });
});

describe("party resolvers (wired by the worker)", () => {
  it("prismaDirectory returns null until wired, then delegates", async () => {
    setPartyResolvers({});
    expect(await prismaDirectory.orderParties!("o")).toBeNull();
    expect(await prismaDirectory.ondcOrderSeller!("o")).toBeNull();
    expect(await prismaDirectory.creditApplicationBusiness!("a")).toBeNull();
    expect(await prismaDirectory.negotiationParties!("n")).toBeNull();
    setPartyResolvers({
      orderParties: async () => ({ buyerBusinessId: "B", sellerBusinessId: "S" }), ondcOrderSeller: async () => "S", creditApplicationBusiness: async () => "S",
      negotiationParties: async () => ({ buyerBusinessId: "B", sellerBusinessId: "S" }),
    });
    expect(await prismaDirectory.orderParties!("o")).toEqual({ buyerBusinessId: "B", sellerBusinessId: "S" });
    expect(await prismaDirectory.ondcOrderSeller!("o")).toBe("S");
    expect(await prismaDirectory.creditApplicationBusiness!("a")).toBe("S");
    expect((await prismaDirectory.negotiationParties!("n"))?.sellerBusinessId).toBe("S");
    setPartyResolvers({});
  });
});
