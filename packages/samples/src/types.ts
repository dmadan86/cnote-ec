// Public view/input types of @cnote/samples.
import type { Actor } from "@cnote/enquiry";
import type { DeclineReason, RejectReason, SampleStatus } from "./state";

export type { Actor, SampleStatus, DeclineReason, RejectReason };
export type SampleRole = "buyer" | "seller";

export interface ShipTo {
  name: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  pincode: string;
}

export interface RequestSampleInput {
  /** from a product page: the live listing. Exactly one of listingId / conversationId. */
  listingId?: string;
  /** from a matched conversation; `quoteId` optionally ties the request to one of its quotes */
  conversationId?: string;
  quoteId?: string | null;
  quantity: number;
  note?: string | null;
  language?: string;
  shipTo: ShipTo;
}

export interface AcceptSampleInput {
  /** what the buyer pays for the sample, in paise; defaults to the listing's sample price (0 = free). Recorded only, Phase 1 settles off-platform. */
  amountPaise?: number | null;
  adjustableAgainstBulk?: boolean;
  paymentNote?: string | null;
}
export interface DeclineSampleInput { reason: DeclineReason; note?: string | null }
export interface DispatchSampleInput { courier: string; trackingRef?: string | null }

/** A photo for an evaluation. Type is decided from magic bytes (JPEG/PNG/WebP), never from the declared MIME. */
export interface PhotoUpload { bytes: Uint8Array; mimeType?: string }
export interface EvaluateSampleInput {
  approved: boolean;
  reasons?: RejectReason[];
  notes?: string | null;
  photos?: PhotoUpload[];
}

export interface TimelineEntry { status: SampleStatus; actor: "buyer" | "seller" | "system"; note: string | null; at: string }

export interface SampleView {
  id: string;
  role: SampleRole;
  status: SampleStatus;
  subject: string;
  listingId: string | null;
  enquiryId: string | null;
  matchId: string | null;
  quoteId: string | null;
  quantity: number;
  unit: string | null;
  buyerNote: string | null;
  buyer: { businessId: string; name: string; verificationTier: number };
  seller: { businessId: string; name: string };
  /** hidden from the seller until the request is accepted, and after the retention purge */
  shipTo: ShipTo | null;
  payment: { amountPaise: number; adjustableAgainstBulk: boolean; note: string | null; receivedAt: string | null; free: boolean };
  respondBy: string;
  /** requested and past respondBy but the sweep has not run yet */
  overdue: boolean;
  respondedAt: string | null;
  declineReason: DeclineReason | null;
  declineNote: string | null;
  expectedDispatchBy: string | null;
  courier: string | null;
  trackingRef: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveredBy: "buyer" | "seller" | null;
  evaluation: { approved: boolean; reasons: RejectReason[]; notes: string | null; photos: { id: string }[]; at: string } | null;
  bulkEnquiryId: string | null;
  createdAt: string;
  timeline: TimelineEntry[];
  /** what this actor can do next (drives the UI; every function re-checks) */
  can: {
    cancel: boolean;
    respond: boolean;
    dispatch: boolean;
    markDelivered: boolean;
    recordPayment: boolean;
    evaluate: boolean;
    requestBulk: boolean;
    acceptLinkedQuote: boolean;
  };
}

export interface SampleSummary {
  id: string;
  role: SampleRole;
  status: SampleStatus;
  subject: string;
  quantity: number;
  unit: string | null;
  counterparty: { businessId: string; name: string };
  respondBy: string;
  overdue: boolean;
  createdAt: string;
  /** the actor has something to do */
  needsMyAction: boolean;
}

export interface SellerSampleStats {
  sellerBusinessId: string;
  evaluated: number;
  approved: number;
  /** approved / evaluated, or null below the minimum sample size */
  approvalRate: number | null;
  /** requests that expired unanswered (SLA misses) */
  expired: number;
  /** requests the seller answered (accepted or declined) */
  responded: number;
}

/** A sample the buyer approved, shown on the order / PO page as the quality reference ("golden sample"). */
export interface GoldenSampleView {
  id: string;
  subject: string;
  quantity: number;
  unit: string | null;
  approvedAt: string;
  notes: string | null;
  photos: { id: string }[];
  /** the buyer and seller see the same card; `role` is the viewer's */
  role: SampleRole;
}

export interface BulkPrefill {
  sampleId: string;
  subject: string;
  sellerBusinessId: string;
  sellerName: string;
  listingId: string | null;
  categorySlug: string | null;
  quantityUnit: string | null;
  /** the linked quote, when the sample was requested against one: the buyer can accept it instead of raising a new RFQ */
  quoteId: string | null;
  /** text to add to the requirement so the supplier sees the quality reference */
  requirementNote: string;
}
