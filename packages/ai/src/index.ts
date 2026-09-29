// @cnote/ai — AI-Orchestration module (ADR-008). The ONLY place that talks to model vendors.
// Every capability: typed input/output, provider-agnostic, logs an AiDecision (redacted input,
// model id, prompt version, latency), and enqueues a ReviewItem when confidence < threshold.
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";

export type Lang = "en" | "hi" | "kn" | "ta" | "te" | "mr" | "gu" | "bn";

/** Links a decision to the thing it's about, for audit + the review queue. */
export interface Subject {
  type: "enquiry" | "listing" | "business" | "message";
  id: string;
}

export type AiResult<T> = T & {
  decisionId: string;
  confidence: number; // 0..1
  /** true when confidence < capability threshold; a ReviewItem was enqueued */
  needsReview: boolean;
};

export interface IntentInput {
  title: string;
  requirement: string;
  quantity?: number | null;
  quantityUnit?: string | null;
  targetPricePaise?: number | null;
  deliveryPincode?: string | null;
  neededBy?: string | null; // ISO date
  buyerVerificationTier: number;
  buyerPhoneVerified: boolean;
  buyerPriorEnquiries: number;
  buyerPriorResponded: number;
  /** cosine similarity to the buyer's most similar enquiry in the last 7 days, if any */
  nearDuplicateSimilarity?: number | null;
}
export interface IntentOutput {
  score: number; // 0–100
  reasons: string[]; // human-readable, shown to sellers
}

export interface ExtractListingInput {
  text: string; // seller's free text / transcribed voice note
  language: Lang;
  categories: { slug: string; name: string; attributeSchema: unknown }[];
}
export interface ExtractListingOutput {
  title: string;
  description: string;
  categorySlug: string | null;
  attributes: Record<string, string | number>;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  moqUnit: string | null;
  hsn: string | null;
}

export interface ModerateInput {
  text: string;
  categorySlug?: string | null;
}
export interface ModerateOutput {
  verdict: "allow" | "review" | "block";
  /** matched prohibited classes, e.g. ["pharma", "weapons"] */
  flags: string[];
  reason: string | null;
}

export async function scoreIntent(input: IntentInput, subject: Subject): Promise<AiResult<IntentOutput>> {
  void input; void subject;
  throw new Error("not implemented");
}

/** Embeddings in the platform vector space (EMBEDDING_DIM from @cnote/db). Not logged as decisions. */
export async function embed(texts: string[]): Promise<{ vectors: number[][]; version: string }> {
  void texts;
  throw new Error("not implemented");
}

export async function extractListing(input: ExtractListingInput, subject: Subject): Promise<AiResult<ExtractListingOutput>> {
  void input; void subject;
  throw new Error("not implemented");
}

export async function moderate(input: ModerateInput, subject: Subject): Promise<AiResult<ModerateOutput>> {
  void input; void subject;
  throw new Error("not implemented");
}

/** Cosine similarity helper for callers comparing embeddings in memory. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---- Human-in-the-loop queue (ops UI) ----
export interface ReviewItemView {
  id: string;
  capability: string;
  subjectType: string;
  subjectId: string;
  reason: string;
  confidence: number | null;
  output: unknown;
  createdAt: string;
}
export async function listOpenReviews(limit = 50): Promise<ReviewItemView[]> {
  void limit;
  throw new Error("not implemented");
}
/** Marks the item resolved. Owning modules react to the outcome via their own ops actions. */
export async function resolveReview(id: string, outcome: "approved" | "rejected", reviewerPersonId: string): Promise<ReviewItemView> {
  void id; void outcome; void reviewerPersonId;
  throw new Error("not implemented");
}

export const worker: ModuleWorker = { name: "ai", handlers: {}, jobs: [] };
