// Phase 2/3 notification kinds (ads, a2a, escrow, disputes, credit, quality, ONDC, quote drafts, order tracking).
// Same contract as kinds.ts: each kind observes one domain event, resolves recipients per PERSON and carries default
// copy (English written here, localized copy in copy-phase23.ts). All are TRANSACTIONAL: they map onto the existing
// categories (billing = money/ads/credit, messages = disputes/agents/tracking, leads = ONDC/quote drafts, listings =
// quality) so per-category preferences apply and none needs marketing consent. Copy is language-neutral where the event
// only offers enums (no English fragments injected through variables) and never names the counterparty (ADR-010).
import type { DomainEvent, DomainEventType } from "@cnote/core";
import { COPY, LOCALES } from "./copy-phase23";
import { fan, HREF, inr, kind, membersOf, RECIPIENT_NAME, v } from "./kind-helpers";
import type { Directory } from "./recipients";
import type { NotificationApp, NotificationCategory, NotificationKind, Recipient } from "./types";

type Side = "buyer" | "seller";
const APP: Record<Side, NotificationApp> = { buyer: "web", seller: "seller" };
const orderHref = (side: Side, orderId: string) => (side === "buyer" ? `/buyer/orders/${orderId}` : `/orders/${orderId}`);
const disputeHref = (side: Side, disputeId: string) => (side === "buyer" ? `/buyer/disputes/${disputeId}` : `/disputes/${disputeId}`);
const negotiationHref = (side: Side, id: string) => (side === "buyer" ? `/buyer/agents/negotiations/${id}` : `/agents/negotiations/${id}`);
const short = (s: string | null | undefined, max = 200) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

interface Spec<E extends DomainEventType> {
  key: string;
  name: string;
  description: string;
  category: NotificationCategory;
  app: NotificationApp;
  event: E;
  variables: ReturnType<typeof v>[];
  subject: string;
  body: string;
  /** appended to the email only (not the in-app text) */
  emailExtra?: string;
  resolve: NotificationKind<E>["resolve"];
}

function mk<E extends DomainEventType>(s: Spec<E>): NotificationKind {
  const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}${s.emailExtra ? `\n\n${s.emailExtra}` : ""}\n\n${cta}: {{href}}`;
  const copy = COPY[s.key];
  return kind<E>({
    key: s.key,
    name: s.name,
    description: s.description,
    category: s.category,
    app: s.app,
    event: s.event,
    variables: [...s.variables, RECIPIENT_NAME, HREF],
    defaults: { in_app: { subject: s.subject, body: s.body }, email: { subject: s.subject, body: email("Hi", s.body, "Open") } },
    ...(copy
      ? {
          localized: Object.fromEntries(
            LOCALES.map((l) => {
              const [subject, body] = copy[l];
              const hi = l === "hi";
              return [l, { in_app: { subject, body }, ...(hi ? { email: { subject, body: email("नमस्ते", body, "खोलें") } } : {}) }];
            }),
          ),
        }
      : {}),
    resolve: s.resolve,
  });
}

/** buyer + seller members of an order's two parties; empty when the order lookup is not wired or finds nothing. */
async function bothSides(dir: Directory, orderId: string, href: (side: Side) => string, vars: Record<string, unknown> = {}): Promise<Recipient[]> {
  const p = await dir.orderParties?.(orderId);
  if (!p) return [];
  const [b, s] = await Promise.all([membersOf(dir, p.buyerBusinessId), membersOf(dir, p.sellerBusinessId)]);
  return [
    ...fan(b, { businessId: p.buyerBusinessId, app: APP.buyer, vars, href: href("buyer") }),
    ...fan(s, { businessId: p.sellerBusinessId, app: APP.seller, vars, href: href("seller") }),
  ];
}

const isLive = (to: string) => to === "active" || to === "approved";

function adHalt(key: string, name: string, description: string, cause: "wallet" | "eligibility", subject: string, body: string): NotificationKind {
  return mk({
    key, name, description, category: "billing", app: "seller", event: "AdCampaignStatusChanged", variables: [], subject, body,
    async resolve(e: DomainEvent<"AdCampaignStatusChanged">, dir) {
      const p = e.payload;
      if (p.cause !== cause || isLive(p.to)) return [];
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: {}, href: `/ads/${p.campaignId}` });
    },
  });
}

export const PHASE23_KINDS: NotificationKind[] = [
  // ---- ads (ADR-024): seller app, billing category -------------------------------------------------------------
  mk({
    key: "ads.campaign_approved", name: "Ad campaign approved", description: "Staff approved a sponsored campaign after review.",
    category: "billing", app: "seller", event: "AdCampaignReviewed", variables: [],
    subject: "Your ad campaign was approved", body: "Your sponsored campaign passed review and can now go live.",
    async resolve(e: DomainEvent<"AdCampaignReviewed">, dir) {
      if (e.payload.decision !== "approved") return [];
      return fan(await membersOf(dir, e.payload.sellerBusinessId), { businessId: e.payload.sellerBusinessId, vars: {}, href: `/ads/${e.payload.campaignId}` });
    },
  }),
  mk({
    key: "ads.campaign_rejected", name: "Ad campaign not approved", description: "Staff rejected a sponsored campaign; the seller can edit and resubmit.",
    category: "billing", app: "seller", event: "AdCampaignReviewed", variables: [v("reason", "Why it was not approved (reviewer note or reason code)", "Image does not match the product")],
    subject: "Your ad campaign was not approved", body: "Reason: {{reason}}. Edit the campaign and resubmit.",
    async resolve(e: DomainEvent<"AdCampaignReviewed">, dir) {
      const p = e.payload;
      if (p.decision !== "rejected") return [];
      const reason = short(p.note) || short(p.reasonCode?.replace(/_/g, " ")) || "see the campaign for details";
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: { reason }, href: `/ads/${p.campaignId}` });
    },
  }),
  adHalt("ads.campaign_paused_wallet", "Ad campaign paused: wallet empty", "A campaign paused because the ad wallet ran out.", "wallet",
    "Ad campaign paused: wallet empty", "Your ad wallet ran out of balance, so the campaign paused. Top up to resume."),
  adHalt("ads.campaign_paused_eligibility", "Ad campaign paused: eligibility", "A campaign paused because the seller or listing no longer meets ad eligibility rules.", "eligibility",
    "Ad campaign paused: eligibility", "Your campaign no longer meets ad eligibility rules (for example verification or listing status). Open it to see what to fix."),
  mk({
    key: "ads.campaign_suspended", name: "Ad campaign suspended", description: "Staff suspended a campaign.",
    category: "billing", app: "seller", event: "AdCampaignStatusChanged", variables: [],
    subject: "Ad campaign suspended", body: "Our team suspended your campaign. Open it for details.",
    async resolve(e: DomainEvent<"AdCampaignStatusChanged">, dir) {
      const p = e.payload;
      if (p.cause !== "staff" || p.to !== "suspended") return [];
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: {}, href: `/ads/${p.campaignId}` });
    },
  }),
  mk({
    key: "ads.budget_exhausted", name: "Daily ad budget used up", description: "A campaign spent its whole daily budget.",
    category: "billing", app: "seller", event: "AdBudgetExhausted",
    variables: [v("spent", "Spent today", "₹500"), v("dailyBudget", "Daily budget", "₹500"), v("date", "IST date", "2026-09-30")],
    subject: "Daily ad budget used up", body: "On {{date}} you spent {{spent}} of your {{dailyBudget}} daily budget. The campaign resumes with the next day's budget.",
    async resolve(e: DomainEvent<"AdBudgetExhausted">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.sellerBusinessId), {
        businessId: p.sellerBusinessId, vars: { spent: inr(p.spentPaise), dailyBudget: inr(p.dailyBudgetPaise), date: p.istDate }, href: `/ads/${p.campaignId}`,
      });
    },
  }),
  mk({
    key: "ads.wallet_low", name: "Ad wallet balance low", description: "The ad wallet fell below the low-balance threshold.",
    category: "billing", app: "seller", event: "AdWalletLow", variables: [v("balance", "Current balance", "₹120"), v("threshold", "Alert threshold", "₹500")],
    subject: "Ad wallet balance is low", body: "Balance {{balance}} is below {{threshold}}. Top up so your campaigns keep running.",
    async resolve(e: DomainEvent<"AdWalletLow">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.businessId, { ownersOnly: true }), { businessId: p.businessId, vars: { balance: inr(p.balancePaise), threshold: inr(p.thresholdPaise) }, href: "/ads" });
    },
  }),

  // ---- a2a (ADR-020): both apps, messages category -------------------------------------------------------------
  mk({
    key: "a2a.confirmation_needed", name: "Agent deal needs your confirmation", description: "An agent negotiation reached agreement that still needs a human confirmation.",
    category: "messages", app: "web", event: "AgentNegotiationClosed", variables: [v("price", "Agreed unit price", "₹120")],
    subject: "Agent deal needs your confirmation", body: "Your agent reached agreement at {{price}} per unit. Review and confirm it to finalise.",
    async resolve(e: DomainEvent<"AgentNegotiationClosed">, dir) {
      const p = e.payload;
      if (p.outcome !== "accepted" || p.confirmedBy !== null || p.pricePaise === null) return [];
      const n = await dir.negotiationParties?.(p.negotiationId);
      if (!n) return [];
      const need = new Set(n.awaitingConfirmation ?? [n.buyerBusinessId, n.sellerBusinessId]);
      const out: Recipient[] = [];
      for (const side of ["buyer", "seller"] as const) {
        const businessId = side === "buyer" ? n.buyerBusinessId : n.sellerBusinessId;
        if (!need.has(businessId)) continue;
        out.push(...fan(await membersOf(dir, businessId), { businessId, app: APP[side], vars: { price: inr(p.pricePaise) }, href: negotiationHref(side, p.negotiationId) }));
      }
      return out;
    },
  }),
  mk({
    key: "a2a.agreed_auto", name: "Agent closed a deal", description: "An agent auto-accepted a deal under the principal's mandate.",
    category: "messages", app: "web", event: "AgentNegotiationClosed", variables: [v("price", "Agreed unit price", "₹120")],
    subject: "Your agent closed a deal", body: "Under your auto-accept mandate your agent agreed a deal at {{price}} per unit.",
    async resolve(e: DomainEvent<"AgentNegotiationClosed">, dir) {
      const p = e.payload;
      if (p.outcome !== "accepted" || p.confirmedBy !== "auto" || p.pricePaise === null) return [];
      const n = await dir.negotiationParties?.(p.negotiationId);
      if (!n) return [];
      const out: Recipient[] = [];
      for (const side of ["buyer", "seller"] as const) {
        const businessId = side === "buyer" ? n.buyerBusinessId : n.sellerBusinessId;
        out.push(...fan(await membersOf(dir, businessId), { businessId, app: APP[side], vars: { price: inr(p.pricePaise) }, href: negotiationHref(side, p.negotiationId) }));
      }
      return out;
    },
  }),
  mk({
    key: "a2a.ended", name: "Agent negotiation ended", description: "An agent negotiation ended without a deal (rejected or expired).",
    category: "messages", app: "web", event: "AgentNegotiationClosed", variables: [],
    subject: "Agent negotiation ended", body: "The negotiation ended without a deal. Open it to review what happened.",
    async resolve(e: DomainEvent<"AgentNegotiationClosed">, dir) {
      const p = e.payload;
      if (p.outcome !== "rejected" && p.outcome !== "expired") return [];
      const n = await dir.negotiationParties?.(p.negotiationId);
      if (!n) return [];
      const out: Recipient[] = [];
      for (const side of ["buyer", "seller"] as const) {
        const businessId = side === "buyer" ? n.buyerBusinessId : n.sellerBusinessId;
        out.push(...fan(await membersOf(dir, businessId), { businessId, app: APP[side], vars: {}, href: negotiationHref(side, p.negotiationId) }));
      }
      return out;
    },
  }),
  mk({
    key: "a2a.mandate_suspended", name: "Agent suspended by support", description: "Support suspended an agent mandate or all agent activity of the business.",
    category: "messages", app: "web", event: "AgentMandateSuspended", variables: [],
    subject: "Your agent was paused by support", body: "Support paused your agent and withdrew its open negotiations. Open agent settings to see details or contact support.",
    async resolve(e: DomainEvent<"AgentMandateSuspended">, dir) {
      const p = e.payload;
      const sides: Side[] = p.side ? [p.side] : ["buyer", "seller"];
      const members = await membersOf(dir, p.businessId);
      return sides.flatMap((side) => fan(members, { businessId: p.businessId, app: APP[side], vars: {}, href: side === "buyer" ? "/buyer/agents" : "/agents" }));
    },
  }),
  mk({
    key: "a2a.offer_awaiting", name: "Agent offer awaiting your reply", description: "An offer arrived that a human (not an agent) must answer.",
    category: "messages", app: "web", event: "AgentOfferMade", variables: [v("price", "Offered unit price", "₹120"), v("quantity", "Quantity offered", "500")],
    subject: "New offer awaiting your reply", body: "An offer of {{price}} per unit for {{quantity}} units needs your decision.",
    async resolve(e: DomainEvent<"AgentOfferMade">, dir) {
      const p = e.payload;
      const n = await dir.negotiationParties?.(p.negotiationId);
      const target = n?.awaitingReplyBusinessId;
      if (!n || !target) return []; // the other side's agent answers by itself
      const side: Side = target === n.buyerBusinessId ? "buyer" : "seller";
      return fan(await membersOf(dir, target), {
        businessId: target, app: APP[side], vars: { price: inr(p.pricePaise), quantity: p.quantity }, href: negotiationHref(side, p.negotiationId),
      });
    },
  }),

  // ---- escrow (ADR-012): money category (billing) --------------------------------------------------------------
  mk({
    key: "escrow.funded", name: "Buyer funded escrow", description: "The buyer's funds are held in escrow; the seller can dispatch.",
    category: "billing", app: "seller", event: "EscrowFunded", variables: [v("amount", "Amount held", "₹25,000")],
    subject: "Buyer funded escrow", body: "{{amount}} is held safely for your order. You can dispatch now.",
    async resolve(e: DomainEvent<"EscrowFunded">, dir) {
      const p = e.payload;
      const o = await dir.orderParties?.(p.orderId);
      if (!o) return [];
      return fan(await membersOf(dir, o.sellerBusinessId), { businessId: o.sellerBusinessId, vars: { amount: inr(p.amountPaise) }, href: orderHref("seller", p.orderId) });
    },
  }),
  mk({
    key: "escrow.released", name: "Escrow released", description: "Escrow funds were released to the seller; payout follows.",
    category: "billing", app: "seller", event: "EscrowReleased", variables: [v("amount", "Amount released", "₹25,000"), v("fee", "Platform fee", "₹250")],
    subject: "Escrow released", body: "{{amount}} was released for your order (platform fee {{fee}}). Payout is on its way.",
    async resolve(e: DomainEvent<"EscrowReleased">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.sellerBusinessId), {
        businessId: p.sellerBusinessId, vars: { amount: inr(p.amountPaise), fee: inr(p.feePaise) }, href: orderHref("seller", p.orderId),
      });
    },
  }),
  mk({
    key: "escrow.payout_settled", name: "Payout settled", description: "The payout reached the seller's account.",
    category: "billing", app: "seller", event: "PayoutSettled", variables: [v("amount", "Amount paid out", "₹24,750")],
    subject: "Payout settled", body: "{{amount}} was paid out to your account.",
    async resolve(e: DomainEvent<"PayoutSettled">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: { amount: inr(p.amountPaise) }, href: "/orders" });
    },
  }),
  mk({
    key: "escrow.refunded", name: "Escrow refunded", description: "Escrow funds are being refunded to the buyer.",
    category: "billing", app: "web", event: "EscrowRefunded", variables: [v("amount", "Amount refunded", "₹25,000")],
    subject: "Escrow refunded", body: "{{amount}} from escrow is being refunded to you.",
    async resolve(e: DomainEvent<"EscrowRefunded">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.buyerBusinessId), { businessId: p.buyerBusinessId, vars: { amount: inr(p.amountPaise) }, href: orderHref("buyer", p.orderId) });
    },
  }),
  mk({
    key: "escrow.frozen", name: "Escrow on hold", description: "Escrow funds are held while a dispute is reviewed (both parties).",
    category: "billing", app: "web", event: "EscrowFrozen", variables: [],
    subject: "Escrow on hold", body: "Funds for your order are on hold while a dispute is reviewed.",
    async resolve(e: DomainEvent<"EscrowFrozen">, dir) {
      return bothSides(dir, e.payload.orderId, (side) => disputeHref(side, e.payload.disputeId));
    },
  }),

  // ---- disputes (ADR-013): messages category -------------------------------------------------------------------
  mk({
    key: "dispute.opened", name: "Dispute opened on your order", description: "The other party opened a dispute; the recipient should respond.",
    category: "messages", app: "seller", event: "DisputeOpened", variables: [v("amount", "Disputed amount", "₹25,000")],
    subject: "A dispute was opened on your order", body: "The other party opened a dispute (amount: {{amount}}). Respond with your side and evidence.",
    async resolve(e: DomainEvent<"DisputeOpened">, dir) {
      const p = e.payload;
      const o = await dir.orderParties?.(p.orderId);
      const side: Side = o && o.buyerBusinessId === p.againstBusinessId ? "buyer" : "seller"; // respondents are usually sellers
      return fan(await membersOf(dir, p.againstBusinessId), {
        businessId: p.againstBusinessId, app: APP[side], vars: { amount: p.amountPaise === null ? "not stated" : inr(p.amountPaise) }, href: disputeHref(side, p.disputeId),
      });
    },
  }),
  mk({
    key: "dispute.brief_ready", name: "Dispute review ready", description: "The dispute summary is ready; both parties can review and respond. The recommendation itself is never sent.",
    category: "messages", app: "web", event: "DisputeBriefReady", variables: [],
    subject: "Dispute review is ready", body: "We prepared a summary of your dispute. Open it to check the details and respond.",
    async resolve(e: DomainEvent<"DisputeBriefReady">, dir) {
      return bothSides(dir, e.payload.orderId, (side) => disputeHref(side, e.payload.disputeId));
    },
  }),
  mk({
    key: "dispute.resolved", name: "Dispute resolved", description: "A dispute was decided; both parties see the refund and release amounts (fault is never included).",
    category: "messages", app: "web", event: "DisputeResolved", variables: [v("refund", "Refund to buyer", "₹5,000"), v("release", "Released to seller", "₹20,000")],
    subject: "Dispute resolved", body: "Refund to buyer: {{refund}}. Released to seller: {{release}}.",
    async resolve(e: DomainEvent<"DisputeResolved">, dir) {
      const p = e.payload;
      return bothSides(dir, p.orderId, (side) => disputeHref(side, p.disputeId), { refund: inr(p.refundPaise), release: inr(p.releasePaise) });
    },
  }),

  // ---- credit (ADR-019/022): seller app, owners only (financial), billing category -----------------------------
  mk({
    key: "credit.offer_received", name: "Financing offer received", description: "A lender offer is ready for the business to review.",
    category: "billing", app: "seller", event: "CreditOfferReceived", variables: [v("amount", "Offer amount", "₹1,00,000"), v("tenor", "Tenor in days", "60"), v("apr", "APR percent", "18")],
    subject: "You have a financing offer", body: "{{amount}} for {{tenor}} days at {{apr}}% APR. Read the Key Fact Statement before accepting.",
    async resolve(e: DomainEvent<"CreditOfferReceived">, dir) {
      const p = e.payload;
      const businessId = await dir.creditApplicationBusiness?.(p.applicationId);
      if (!businessId) return [];
      return fan(await membersOf(dir, businessId, { ownersOnly: true }), { businessId, vars: { amount: inr(p.amountPaise), tenor: p.tenorDays, apr: p.aprBps / 100 }, href: "/credit" });
    },
  }),
  mk({
    key: "credit.disbursed", name: "Financing disbursed", description: "Loan proceeds were disbursed.",
    category: "billing", app: "seller", event: "CreditDisbursed", variables: [v("amount", "Amount disbursed", "₹1,00,000")],
    subject: "Financing disbursed", body: "{{amount}} was disbursed to your account.",
    async resolve(e: DomainEvent<"CreditDisbursed">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.businessId, { ownersOnly: true }), { businessId: p.businessId, vars: { amount: inr(p.amountPaise) }, href: "/credit" });
    },
  }),
  mk({
    key: "credit.overdue", name: "Loan repayment overdue", description: "A loan is past its due date.",
    category: "billing", app: "seller", event: "CreditOverdue", variables: [v("dpd", "Days past due", "3")],
    subject: "Repayment overdue", body: "Your loan is {{dpd}} day(s) overdue. Please repay to avoid extra charges and score impact.",
    async resolve(e: DomainEvent<"CreditOverdue">, dir) {
      const p = e.payload;
      if (p.dpd < 1) return [];
      return fan(await membersOf(dir, p.businessId, { ownersOnly: true }), { businessId: p.businessId, vars: { dpd: p.dpd }, href: "/credit" });
    },
  }),
  mk({
    key: "credit.closed", name: "Loan closed", description: "A loan was closed (repaid or written off).",
    category: "billing", app: "seller", event: "CreditClosed", variables: [],
    subject: "Loan closed", body: "Your loan is now closed. Details are on your credit page.",
    async resolve(e: DomainEvent<"CreditClosed">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.businessId, { ownersOnly: true }), { businessId: p.businessId, vars: {}, href: "/credit" });
    },
  }),
  mk({
    key: "credit.cancelled", name: "Financing cancelled", description: "A financing application/loan was cancelled (cooling-off or partner).",
    category: "billing", app: "seller", event: "CreditCancelled", variables: [],
    subject: "Financing cancelled", body: "Your financing was cancelled. Check your credit page for any settlement.",
    async resolve(e: DomainEvent<"CreditCancelled">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.businessId, { ownersOnly: true }), { businessId: p.businessId, vars: {}, href: "/credit" });
    },
  }),

  // ---- quality (ADR-014), ONDC (ADR-021), quote drafts, order tracking ------------------------------------------
  mk({
    key: "quality.check_completed", name: "Quality check finished", description: "An AI quality check on an order finished (verdict and confidence are shown in the app, not in the message).",
    category: "listings", app: "seller", event: "QualityCheckCompleted", variables: [],
    subject: "Quality check finished", body: "The quality check for your order is complete. Open the order to see the result.",
    async resolve(e: DomainEvent<"QualityCheckCompleted">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: {}, href: orderHref("seller", p.orderId) });
    },
  }),
  mk({
    key: "ondc.order_received", name: "New ONDC order", description: "An order arrived from the ONDC network.",
    category: "leads", app: "seller", event: "OndcOrderReceived", variables: [],
    subject: "New ONDC order", body: "You received an order from the ONDC network. Accept or reject it in time.",
    async resolve(e: DomainEvent<"OndcOrderReceived">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: {}, href: "/ondc/orders" });
    },
  }),
  mk({
    key: "ondc.issue_received", name: "ONDC issue raised", description: "A buyer raised an issue (IGM) on an ONDC order.",
    category: "leads", app: "seller", event: "OndcIssueReceived", variables: [],
    subject: "ONDC issue raised", body: "A buyer raised an issue on an ONDC order. Open it to respond.",
    async resolve(e: DomainEvent<"OndcIssueReceived">, dir) {
      const p = e.payload;
      const businessId = await dir.ondcOrderSeller?.(p.ondcOrderId);
      if (!businessId) return [];
      return fan(await membersOf(dir, businessId), { businessId, vars: {}, href: p.disputeId ? disputeHref("seller", p.disputeId) : "/ondc/orders" });
    },
  }),
  mk({
    key: "negotiation.draft_ready", name: "Quote draft ready", description: "An AI quote draft is ready for the seller to approve (nothing is sent to the buyer until approved).",
    category: "leads", app: "seller", event: "QuoteDraftGenerated", variables: [v("price", "Drafted unit price", "₹120")],
    subject: "Quote draft ready", body: "We drafted a quote (price: {{price}}). Review and approve it before it is sent.",
    async resolve(e: DomainEvent<"QuoteDraftGenerated">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.sellerBusinessId), { businessId: p.sellerBusinessId, vars: { price: p.pricePaise === null ? "not set" : inr(p.pricePaise) }, href: "/leads" });
    },
  }),
  mk({
    key: "order.fulfilment_updated", name: "Delivery update on your order", description: "The seller posted a tracking stage (packed, in transit, out for delivery, delivery attempted).",
    category: "messages", app: "web", event: "OrderFulfilmentUpdated", variables: [v("note", "Seller's tracking note (may be empty)", "Courier: 2 attempts made")],
    subject: "Delivery update on your order", body: "There is a new tracking update. Open the order to see it.", emailExtra: "{{note}}",
    async resolve(e: DomainEvent<"OrderFulfilmentUpdated">, dir) {
      const p = e.payload;
      return fan(await membersOf(dir, p.buyerBusinessId), { businessId: p.buyerBusinessId, vars: { note: short(p.note) }, href: orderHref("buyer", p.orderId) });
    },
  }),
];
