// Public view/input types of @cnote/enquiry (re-exported from index.ts).

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
  status: "scoring" | "review" | "matched" | "unmatched" | "closed" | "rejected";
  createdAt: string;
  matches: MatchView[];
  /** Buyer chose to pick sellers manually (ADR-002 option 4). */
  buyerPicks?: boolean;
  /** Max sellers this lead is offered to (N, ADR-002). */
  sellerCap?: number;
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
  quotes: { id: string; pricePaise: number; quantity: number; unit: string; leadTimeDays: number | null; notes: string | null; validUntil: string | null; createdAt: string }[];
  dealReported: "won" | "lost" | "pending" | null;
  /** Which side the requesting actor is on. */
  role?: "buyer" | "seller";
  enquiryId?: string;
}
