// @cnote/ai — AI-Orchestration module (ADR-008). The ONLY place that talks to model vendors.
// Every capability: typed input/output, provider-agnostic, logs an AiDecision (redacted input,
// model id, prompt version, latency), and enqueues a ReviewItem when confidence < threshold.
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import { createHash } from "node:crypto";
import { DomainError, type ModuleWorker } from "@cnote/core";
import { INPUT_RETENTION_DAYS, listOpenReviewsImpl, purgeOldDecisionInputs, resolveReviewImpl, runLogged } from "./decisions";
import { redactDeep, redactPii } from "./redact";
import { getProviders, heuristicProviders } from "./registry";
import { MAX_AUDIO_MS, assertAudio, getSpeechToText } from "./speech";
import { assertVisionImages, imageAudit } from "./vision";

export type Lang = "en" | "hi" | "kn" | "ta" | "te" | "mr" | "gu" | "bn";

/** Links a decision to the thing it's about, for audit + the review queue. */
export interface Subject {
  type: "enquiry" | "listing" | "business" | "message" | "voice_note";
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

export interface VisionImage {
  bytes: Uint8Array;
  /** image/jpeg | image/png | image/webp only. EXIF must already be stripped by the caller. */
  mimeType: string;
  /** optional, for the audit log only (the log never stores pixels) */
  width?: number;
  height?: number;
}
export interface ExtractListingFromImagesInput {
  /** 1-4 photos of one product, pre-resized by the caller to <= 1568 px on the long edge */
  images: VisionImage[];
  hintText?: string;
  language: Lang;
  categories: ExtractListingInput["categories"];
}
export interface ExtractListingFromImagesOutput extends ExtractListingOutput {
  /** things visible in the photos: colour, material, finish... */
  visualAttributes: Record<string, string>;
  detected: { productType: string; quantityVisible: number | null };
}

export interface TranscribeInput {
  audio: { bytes: Uint8Array; mimeType: string };
  languageHint?: Lang;
}
export interface TranscribeOutput {
  text: string;
  /** ISO 639-1 code of the spoken language, or "unknown" */
  language: string;
  confidence: number; // 0..1
  durationMs: number;
  segments?: { text: string; startMs: number; endMs: number }[];
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
  return runLogged("intent", subject, redactDeep(input), () => getProviders().intent.score(input));
}

/** Embeddings in the platform vector space (EMBEDDING_DIM from @cnote/db). Not logged as decisions. */
export async function embed(texts: string[]): Promise<{ vectors: number[][]; version: string }> {
  const e = getProviders().embedder;
  return { vectors: await e.embed(texts), version: e.version };
}

export async function extractListing(input: ExtractListingInput, subject: Subject): Promise<AiResult<ExtractListingOutput>> {
  const audit = { text: input.text, language: input.language, categories: input.categories.map((c) => c.slug) };
  return runLogged("extract", subject, redactDeep(audit), () => getProviders().extractor.extract(input));
}

/** Photos (+ optional hint) → structured draft fields. Always reviewed by the seller; low confidence also goes to the ops queue. */
export async function extractListingFromImages(input: ExtractListingFromImagesInput, subject: Subject): Promise<AiResult<ExtractListingFromImagesOutput>> {
  assertVisionImages(input.images);
  const p = getProviders();
  const run = () => (p.imageExtractor ?? heuristicProviders.imageExtractor!).extract(input);
  return runLogged("extract_image", subject, redactDeep(imageAudit(input)), run);
}

/** Audio → transcript via the ASR port (ASR_PROVIDER). The logged output holds the redacted transcript only. */
export async function transcribe(input: TranscribeInput, subject: Subject): Promise<AiResult<TranscribeOutput>> {
  const mime = assertAudio(input.audio);
  const audit = { mimeType: mime, bytes: input.audio.bytes.length, sha256: createHash("sha256").update(input.audio.bytes).digest("hex"), languageHint: input.languageHint ?? null };
  return runLogged("transcribe", subject, audit, async () => {
    const r = await getSpeechToText().transcribe(input);
    if (r.output.durationMs > MAX_AUDIO_MS) throw new DomainError("validation", "Recording is longer than 5 minutes");
    return r;
  }, (o) => (o.text.trim() ? null : "Empty transcript"), (o) => ({ ...o, text: redactPii(o.text), segments: undefined }));
}

export async function moderate(input: ModerateInput, subject: Subject): Promise<AiResult<ModerateOutput>> {
  return runLogged("moderate", subject, redactDeep(input), () => getProviders().moderator.moderate(input),
    // ADR-003: a "review" verdict always goes to a human, whatever the confidence
    (o) => (o.verdict === "review" ? `Moderation needs review: ${o.reason ?? o.flags.join(", ")}` : null));
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
  return listOpenReviewsImpl(limit);
}
/** Marks the item resolved. Owning modules react to the outcome via their own ops actions. */
export async function resolveReview(id: string, outcome: "approved" | "rejected", reviewerPersonId: string): Promise<ReviewItemView> {
  return resolveReviewImpl(id, outcome, reviewerPersonId);
}

// ---- Additions (non-breaking) ----
export { redactPii, redactDeep } from "./redact";
export { REVIEW_THRESHOLDS, purgeOldDecisionInputs } from "./decisions";
export { EMBEDDER_VERSION, embedText } from "./embedder";
export { getSpeechToText, setSpeechToTextForTests, MockSpeechToText, SarvamSpeechToText, MOCK_TRANSCRIPT_PREFIX, MAX_AUDIO_BYTES, MAX_AUDIO_MS, AUDIO_EXT, assertAudio, type SarvamOptions } from "./speech";
export { MAX_VISION_IMAGES, VISION_MAX_LONG_EDGE, VISION_MIMES } from "./vision";
export { getProviders, setProvidersForTests, heuristicProviders, anthropicProviders } from "./registry";
export type { Providers, IntentScorer, ListingExtractor, ImageListingExtractor, SpeechToText, Moderator, Embedder, ProviderResult } from "./types";

const DAY_MS = 86_400_000;
export const worker: ModuleWorker = {
  name: "ai",
  handlers: {},
  jobs: [
    {
      // ADR-010: input retention. Rows stay for audit; only the redacted input is dropped.
      name: "ai.purge-decision-inputs",
      everyMs: DAY_MS,
      run: async () => {
        const n = await purgeOldDecisionInputs(new Date(), INPUT_RETENTION_DAYS);
        if (n) console.log(`[ai] purged input of ${n} decisions older than ${INPUT_RETENTION_DAYS}d`);
      },
    },
  ],
};

export * from "./getters";
export * from "./document";
