import type { InspectionCheck, InspectionResult } from "@cnote/ai";

export interface QualityActor { personId: string; businessId: string }

export interface ExpectedSpec {
  productTitle: string;
  quantity: number | null;
  unit: string | null;
  requirement: string;
  attributes: Record<string, string | number>;
  labelling: string[];
}

/** What the order context port returns (default impl composes enquiry + catalogue public functions). */
export interface OrderContext {
  orderId: string;
  role: "buyer" | "seller";
  status: string;
  sellerBusinessId: string;
  categorySlug: string | null;
  spec: ExpectedSpec;
}

export interface OrderContextPort { load(actor: QualityActor, orderId: string): Promise<OrderContext | null> }

export type IneligibleReason = "disabled" | "not_found" | "not_seller" | "no_category" | "category_not_enabled" | "order_status" | "limit_reached";

export interface ChecklistItem { check: InspectionCheck; label: string; expected: string }

export interface SubmissionContext {
  eligible: boolean;
  reason?: IneligibleReason;
  categorySlug: string | null;
  checklist: ChecklistItem[];
  maxPhotos: number;
  checksUsed: number;
  maxChecks: number;
}

export interface CheckResultView { check: InspectionCheck; result: InspectionResult; confidence: number; note: string }

export interface QualityCheckView {
  id: string;
  orderId: string;
  sellerBusinessId: string;
  categorySlug: string;
  status: "pending" | "analysing" | "completed" | "failed";
  verdict: InspectionResult | null;
  confidence: number | null;
  needsReview: boolean;
  results: CheckResultView[];
  mediaIds: string[];
  createdAt: string;
  completedAt: string | null;
  /** Always true: outputs are advisory evidence, never pass/fail (ADR-015). */
  advisory: true;
}

/** What disputes consumes (ADR-013): completed checks only, advisory, no media handles. */
export interface AdvisoryEvidence {
  checkId: string;
  orderId: string;
  sellerBusinessId: string;
  categorySlug: string;
  verdict: InspectionResult;
  confidence: number;
  needsReview: boolean;
  results: CheckResultView[];
  photoCount: number;
  completedAt: string;
  advisory: true;
  disclaimer: string;
}
