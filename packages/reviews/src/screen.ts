import * as ai from "@cnote/ai";
import type { UgcStatus } from "./types";

export interface Screen {
  status: "pending" | "flagged";
  aiVerdict: string | null;
  aiDecisionId: string | null;
}

/**
 * AI pre-screen (ADR-008/010). Subject type is "message" (user-authored text), NOT "listing": a
 * "review" verdict enqueues an ai ReviewItem, and the admin review queue applies listing subjects
 * to catalogue.resolveListingModeration, which would wrongly approve/reject the listing itself.
 * The verdict never publishes anything: allow → pending, review/block → flagged; staff always decide.
 * If the model is unavailable we fall back to pending with no verdict (still human-gated).
 */
export async function screenText(text: string, subjectId: string): Promise<Screen> {
  try {
    const r = await ai.moderate({ text }, { type: "message", id: subjectId });
    return { status: r.verdict === "allow" ? "pending" : "flagged", aiVerdict: r.verdict, aiDecisionId: r.decisionId };
  } catch (err) {
    console.error("[reviews] moderation pre-screen failed", err instanceof Error ? err.message : err);
    return { status: "pending", aiVerdict: null, aiDecisionId: null };
  }
}

/** flagged is internal; authors just see "awaiting approval". */
export const authorStatus = (s: UgcStatus): "pending" | "approved" | "rejected" => (s === "flagged" ? "pending" : s);

export interface QaScreen {
  /** allow → approved (private until answered); review/block/anything else → flagged for staff; model down → pending (still staff-gated) */
  status: "pending" | "flagged" | "approved";
  aiVerdict: string | null;
  aiDecisionId: string | null;
}

/**
 * Pre-screen for questions and answers. Unlike reviews, a clean question is auto-approved because it stays private to
 * its asker and the seller until a moderated answer exists, and answers pass through this same gate. The category slug
 * lets the prohibited-category classifier apply (ADR-003/010). Never auto-rejects: block verdicts go to staff.
 */
export async function screenQa(text: string, subjectId: string, categorySlug?: string): Promise<QaScreen> {
  try {
    const r = await ai.moderate({ text, ...(categorySlug ? { categorySlug } : {}) }, { type: "message", id: subjectId });
    return { status: r.verdict === "allow" ? "approved" : "flagged", aiVerdict: r.verdict, aiDecisionId: r.decisionId };
  } catch (err) {
    console.error("[reviews] qa moderation pre-screen failed", err instanceof Error ? err.message : err);
    return { status: "pending", aiVerdict: null, aiDecisionId: null };
  }
}
