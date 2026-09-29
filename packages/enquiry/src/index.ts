// @cnote/enquiry — RFQ/enquiry, intent-scored exclusive matching, messaging, quotes, deal reports (ADR-002, ADR-007).
// PUBLIC CONTRACT. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";

export interface EnquiryInput {
  title: string;
  requirement: string;
  categorySlug?: string | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  targetPricePaise?: number | null;
  deliveryCity?: string | null;
  deliveryPincode?: string | null;
  neededBy?: string | null; // ISO date
  language?: string;
  buyerPicks?: boolean;
  /** Optional: enquiry started from a listing page — that seller is ranked first if eligible. */
  preferredListingId?: string | null;
}

export interface Actor {
  personId: string;
  businessId: string;
}

export interface MatchView {
  id: string;
  enquiryId: string;
  sellerBusinessId: string;
  sellerName: string;
  rank: number;
  of: number; // N — sellers see "rank r of N"
  matchScore: number;
  status: "offered" | "accepted" | "declined" | "expired" | "refunded";
  respondBy: string;
  conversationId: string | null;
}

export interface EnquiryView {
  id: string;
  title: string;
  requirement: string;
  category: { slug: string; name: string } | null;
  quantity: number | null;
  quantityUnit: string | null;
  targetPricePaise: number | null;
  deliveryCity: string | null;
  deliveryPincode: string | null;
  neededBy: string | null;
  intentScore: number | null;
  intentReasons: string[];
  status: "scoring" | "review" | "matched" | "unmatched" | "closed" | "rejected";
  createdAt: string;
  matches: MatchView[];
}

/** Seller-side view of a lead. Buyer contact is revealed only after accept. */
export interface LeadView {
  matchId: string;
  enquiry: Omit<EnquiryView, "matches">;
  rank: number;
  of: number;
  status: MatchView["status"];
  respondBy: string;
  buyer: { businessName: string; city: string | null; verificationTier: number; phone: string | null };
  conversationId: string | null;
}

/** Validates, moderates, embeds, scores intent, matches top-N sellers synchronously (< 2s). */
export async function createEnquiry(actor: Actor, input: EnquiryInput): Promise<EnquiryView> {
  void actor; void input;
  throw new Error("not implemented");
}
export async function listBuyerEnquiries(buyerBusinessId: string): Promise<EnquiryView[]> {
  void buyerBusinessId;
  throw new Error("not implemented");
}
export async function getBuyerEnquiry(buyerBusinessId: string, enquiryId: string): Promise<EnquiryView | null> {
  void buyerBusinessId; void enquiryId;
  throw new Error("not implemented");
}

export async function listSellerLeads(sellerBusinessId: string): Promise<LeadView[]> {
  void sellerBusinessId;
  throw new Error("not implemented");
}
/** Consumes one credit, reveals buyer, opens a conversation. */
export async function acceptLead(actor: Actor, matchId: string): Promise<LeadView> {
  void actor; void matchId;
  throw new Error("not implemented");
}
/** Within the 2h window; slot cascades to the next-ranked seller. */
export async function declineLead(actor: Actor, matchId: string, reason?: string): Promise<void> {
  void actor; void matchId; void reason;
  throw new Error("not implemented");
}
/** Seller flags buyer unreachable/fake within 72h → verified + auto-refund without a ticket. */
export async function reportBuyerProblem(actor: Actor, matchId: string, kind: "buyer_unreachable" | "buyer_fake"): Promise<void> {
  void actor; void matchId; void kind;
  throw new Error("not implemented");
}
/** Ops release/reject of an enquiry held in review (low confidence). */
export async function resolveEnquiryReview(enquiryId: string, outcome: "approved" | "rejected"): Promise<void> {
  void enquiryId; void outcome;
  throw new Error("not implemented");
}

export interface ConversationView {
  id: string;
  matchId: string;
  enquiryTitle: string;
  buyer: { businessId: string; name: string };
  seller: { businessId: string; name: string };
  messages: { id: string; senderPersonId: string; body: string; createdAt: string }[];
  quotes: { id: string; pricePaise: number; quantity: number; unit: string; leadTimeDays: number | null; notes: string | null; validUntil: string | null; createdAt: string }[];
  dealReported: "won" | "lost" | "pending" | null;
}
export async function getConversation(actor: Actor, conversationId: string): Promise<ConversationView | null> {
  void actor; void conversationId;
  throw new Error("not implemented");
}
export async function sendMessage(actor: Actor, conversationId: string, body: string): Promise<void> {
  void actor; void conversationId; void body;
  throw new Error("not implemented");
}
export async function sendQuote(
  actor: Actor,
  conversationId: string,
  quote: { pricePaise: number; quantity: number; unit: string; leadTimeDays?: number | null; notes?: string | null; validUntil?: string | null },
): Promise<void> {
  void actor; void conversationId; void quote;
  throw new Error("not implemented");
}
/** One-tap "did this close?" (ADR-007). */
export async function reportDeal(actor: Actor, matchId: string, outcome: "won" | "lost" | "pending", valuePaise?: number | null): Promise<void> {
  void actor; void matchId; void outcome; void valuePaise;
  throw new Error("not implemented");
}

/** Jobs: cascade expired offers (2h), auto-refund window checks (72h). */
export const worker: ModuleWorker = { name: "enquiry", handlers: {}, jobs: [] };
