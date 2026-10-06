// Pure sample rules: state machine, structured reason codes, rate maths. No I/O (unit-tested directly).
import { DomainError } from "@cnote/core";

export type SampleStatus = "requested" | "accepted" | "declined" | "dispatched" | "delivered" | "approved" | "rejected" | "expired" | "cancelled";

/** requested -> accepted | declined | expired | cancelled; accepted -> dispatched | cancelled; dispatched -> delivered; delivered -> approved | rejected. */
export const TRANSITIONS: Record<SampleStatus, SampleStatus[]> = {
  requested: ["accepted", "declined", "expired", "cancelled"],
  accepted: ["dispatched", "cancelled"],
  declined: [],
  dispatched: ["delivered"],
  delivered: ["approved", "rejected"],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

/** Statuses in which the request still counts against the buyer's open-request limit and blocks a duplicate. */
export const OPEN_STATUSES: SampleStatus[] = ["requested", "accepted", "dispatched", "delivered"];
export const FINAL_STATUSES: SampleStatus[] = ["declined", "approved", "rejected", "expired", "cancelled"];

export const isOpen = (s: SampleStatus) => OPEN_STATUSES.includes(s);
export const canTransition = (from: SampleStatus, to: SampleStatus) => TRANSITIONS[from].includes(to);
export function assertTransition(from: SampleStatus, to: SampleStatus): void {
  if (!canTransition(from, to)) throw new DomainError("conflict", "That step is not available for a request in its current status.", undefined, "samples.invalidTransition");
}

/** Why a seller declines (structured, so decline rates are analysable; free text is optional). */
export const DECLINE_REASONS = ["out_of_stock", "not_offered", "buyer_tier", "region_not_served", "quantity_too_high", "other"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Structured reasons for rejecting a sample. A rejection needs at least one; an approval needs none. */
export const REJECT_REASONS = [
  "quality_below_spec", "dimensions_off", "material_mismatch", "finish_defect", "colour_mismatch", "packaging_damaged", "not_as_described", "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const MAX_EVALUATION_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Approval rate = approved / evaluated; null until enough samples have been evaluated (small numbers mislead). */
export function approvalRate(approved: number, evaluated: number, minEvaluated: number): number | null {
  if (evaluated < minEvaluated || evaluated <= 0) return null;
  return approved / evaluated;
}

/** Key that makes a second open request for the same product (or conversation) by the same buyer impossible. */
export const activeKeyFor = (buyerBusinessId: string, ctx: { listingId?: string | null; matchId?: string | null }): string =>
  `${buyerBusinessId}:${ctx.listingId ? `l:${ctx.listingId}` : `m:${ctx.matchId}`}`;
