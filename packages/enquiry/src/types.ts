// Public view/input types of @cnote/enquiry (re-exported from index.ts).
import type { AttachmentUpload, AttachmentView } from "./attachments";
import type { EnquiryLineInput, EnquiryLineView } from "./lines";
import type { QuoteView } from "./quotes";

export interface EnquiryInput {
  /** Required unless `lines` is given (then derived from the lines). */
  title?: string;
  /** Required unless `lines` is given. */
  requirement?: string;
  categorySlug?: string | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  targetPricePaise?: number | null;
  deliveryCity?: string | null;
  deliveryPincode?: string | null;
  neededBy?: string | null; // ISO date
  language?: string;
  buyerPicks?: boolean;
  /** Optional budget range per unit, integer paise. */
  budgetMinPaise?: number | null;
  budgetMaxPaise?: number | null;
  /** Quote expiry in days (1-30, default 7). */
  expiresInDays?: number | null;
  /** Preferred supplier tier: only sellers at this verification tier or above are matched (1-3). */
  minSellerTier?: number | null;
  /** Up to 5 drawings/specs (PDF/JPG/PNG, 10 MB each). Stored privately; never sent to an AI model. */
  attachments?: AttachmentUpload[] | null;
  /**
   * Multi-line RFQ / bill of materials (1..50 lines). When given, the RFQ `title` is optional (derived), and
   * `quantity`/`quantityUnit`/`targetPricePaise` mirror line 1. Without it the enquiry is a one-line RFQ made from the single fields.
   */
  lines?: EnquiryLineInput[] | null;
  /** Optional: enquiry started from a listing page — that seller is ranked first if eligible. */
  preferredListingId?: string | null;
  /** Optional: enquiry started from a seller's storefront — that seller is ranked first if eligible. */
  preferredSellerId?: string | null;
}

export interface Actor {
  personId: string;
  businessId: string;
}

/** Optional request context the caller knows but the actor does not. */
export interface CreateEnquiryContext {
  buyerPhoneVerified?: boolean;
  /** Client IP from clientIp() (never parsed from X-Forwarded-For here); adds an IP-keyed posting limit (security audit). */
  ip?: string | null;
  /** Raw User-Agent header; only its family is kept (fake-lead signals, risk.ts). */
  userAgent?: string | null;
}

export interface SellerSummary {
  verificationTier: number;
  badgeActive: boolean;
  trustScore: number;
  city: string | null;
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
  /** Real trust signals for the buyer-facing badge (ADR-003). */
  seller?: SellerSummary;
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
  status: "scoring" | "review" | "matched" | "unmatched" | "closed" | "rejected" | "pending_approval";
  createdAt: string;
  matches: MatchView[];
  /** Buyer chose to pick sellers manually (ADR-002 option 4). */
  buyerPicks?: boolean;
  /** Max sellers this lead is offered to (N, ADR-002). */
  sellerCap?: number;
  budgetMinPaise: number | null;
  budgetMaxPaise: number | null;
  /** ISO timestamp after which the requirement is expired (null on legacy rows). */
  expiresAt: string | null;
  minSellerTier: number | null;
  attachments: AttachmentView[];
  /** Requirement lines (always at least one; line 1 mirrors quantity/unit above). */
  lines: EnquiryLineView[];
  /** Quotes received across all matched sellers (buyer board only). */
  quoteCount?: number;
  /** buyerPicks enquiry with no sellers picked yet (status stays "scoring"; there is no dedicated status). */
  awaitingPick?: boolean;
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
  /** the seller's buyer_fake refund request is held for staff review (security audit M2) */
  refundUnderReview?: boolean;
  /** Why `buyer.phone` is null after accept (consent not granted / no phone). */
  contactNote?: string | null;
  /** Set while an "unreachable" report is being verified with the buyer (refund decided within 24h). */
  reachabilityCheck?: { status: "checking"; expiresAt: string } | null;
}

export interface CandidateView {
  sellerBusinessId: string;
  sellerName: string;
  listingId: string;
  matchScore: number;
  similarity: number;
  verificationTier: number;
  badgeActive: boolean;
  trustScore: number;
  city: string | null;
}

export interface ConversationView {
  id: string;
  matchId: string;
  enquiryTitle: string;
  buyer: { businessId: string; name: string };
  seller: { businessId: string; name: string };
  messages: { id: string; senderPersonId: string; body: string; createdAt: string }[];
  quotes: QuoteView[];
  /** Requirement lines (so a seller can quote line by line). */
  lines: EnquiryLineView[];
  dealReported: "won" | "lost" | "pending" | null;
  /** The seller says the deal closed; only the buyer's own "won" report makes it an order (security audit M7). */
  sellerClaimedWon?: boolean;
  /** Which side the requesting actor is on. */
  role?: "buyer" | "seller";
  enquiryId?: string;
}
