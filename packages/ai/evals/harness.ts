// Eval harness (ADR-008): golden sets in ./data, per-capability metrics, thresholds that gate CI.
import { existsSync, readFileSync } from "node:fs";
import { cosine, getSpeechToText, heuristicProviders, REVIEW_THRESHOLDS } from "../src/index";
import type { ExtractListingInput, ExtractListingOutput, IntentInput } from "../src/index";
import { getProviders } from "../src/registry";
import type { Providers, SpeechToText } from "../src/types";
import { jpegNoExif, mockAudio, syntheticPng, type Pattern, type RGB } from "./fixtures";
import categories from "./data/categories.json";
import embeddingSet from "./data/embedding.json";
import extractionSet from "./data/extraction.json";
import intentSet from "./data/intent.json";
import moderationSet from "./data/moderation.json";
import asrSet from "./data/asr.json";
import visionSet from "./data/vision.json";

export const THRESHOLDS = {
  intentBandAccuracy: 0.85,
  extractionFieldAccuracy: 0.85,
  moderationBlockPrecision: 0.95,
  moderationBlockRecall: 0.9,
  embeddingTripletAccuracy: 0.9,
  visionHintFieldAccuracy: 0.85,
  visionHeuristicNeedsReviewRate: 1,
  asrWordAccuracy: 0.85,
  // Prohibited-category classifier (ADR-003): a block must name the right class, and the scripts sellers actually write in must hold up.
  moderationFlagAccuracy: 0.85,
  moderationScriptBlockRecall: 0.9,
  // Calibration (ADR-008): of the decisions that skip the human queue, this share must be right.
  intentAutoAcceptAccuracy: 0.8,
  extractionAutoAcceptAccuracy: 0.8,
  moderationAutoAcceptAccuracy: 0.9,
} as const;

/** Moderation cases tagged with any of these are the Hinglish / Devanagari / mixed-script / obfuscated slice. */
const SCRIPT_TAGS = ["hinglish", "devanagari", "mixed", "obfuscated"];

/** One scored golden-set case; feeds calibration and latency. */
export interface Sample { id: string; correct: boolean; confidence: number; humanRouted: boolean }
export interface EvalOptions {
  /** cases carrying any of these tags are skipped (the heuristic provider skips "llm-only") */
  skipTags?: string[];
  /** called around every provider call so callers can attribute latency and token cost per capability */
  onCapability?: (capability: string | null) => void;
}

export interface Metric { name: string; value: number; threshold: number; pass: boolean }
export interface EvalReport {
  metrics: Metric[]; failures: string[]; pass: boolean; details: Record<string, string>;
  /** per capability ("intent" | "extract" | "moderate"): scored cases, for calibration */
  samples: Record<string, Sample[]>;
  /** provider calls that threw (or answered via the heuristic fallback) per capability; counted as wrong answers */
  errors: Record<string, number>;
}

const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 1000) / 1000;

interface IntentCase { id: string; input: Partial<IntentInput> & { title: string; requirement: string; neededByDays?: number }; band: [number, number] }
interface ExtractCase { id: string; text: string; language?: ExtractListingInput["language"]; expect: Partial<ExtractListingOutput> & { titleIncludes?: string } }
interface ModCase { id: string; text: string; verdict: "allow" | "review" | "block"; flags?: string[]; tags?: string[] }
const skipped = (c: { tags?: string[] }, skip: string[]) => !!c.tags?.some((t) => skip.includes(t));
interface Triplet { id: string; anchor: string; positive: string; negative: string }

interface VisionCase {
  id: string; language: ExtractListingInput["language"]; hintText?: string;
  fixture: { pattern: Pattern; a: RGB; b: RGB };
  expect: Partial<ExtractListingOutput>;
  live?: { categorySlug?: string; visualAttributesInclude?: string[] };
}
interface AsrCase { id: string; language: ExtractListingInput["language"]; reference: string; audioFile: string | null }

/** Word error rate based accuracy: 1 - WER (Levenshtein over lowercase words), floored at 0. */
export function wordAccuracy(reference: string, hypothesis: string): number {
  const r = reference.toLowerCase().split(/\s+/).filter(Boolean), h = hypothesis.toLowerCase().split(/\s+/).filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)] as number[]);
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? Math.max(0, 1 - d[r.length]![h.length]! / r.length) : 1;
}

const isLive = (name: string, needKey: string) => process.env[name] === needKey.toLowerCase() && !!process.env[needKey === "anthropic" ? "ANTHROPIC_API_KEY" : "SARVAM_API_KEY"];

export async function runEvals(providers: Providers = getProviders(), now = new Date(), asr: SpeechToText = getSpeechToText(), opts: EvalOptions = {}): Promise<EvalReport> {
  const skip = opts.skipTags ?? [];
  const samples: Record<string, Sample[]> = { intent: [], extract: [], moderate: [] };
  const errors: Record<string, number> = { intent: 0, extract: 0, moderate: 0, extract_image: 0 };
  const failures: string[] = [];
  /** A thrown error or a silent heuristic fallback is a wrong answer, never a skipped case. */
  const safe = async <T extends { provider: string }>(cap: string, id: string, fn: () => Promise<T>): Promise<T | null> => {
    opts.onCapability?.(cap);
    try {
      const r = await fn();
      if (r.provider === "heuristic-fallback") throw new Error("answered by heuristic fallback");
      return r;
    } catch (err) {
      errors[cap] = (errors[cap] ?? 0) + 1;
      failures.push(`${cap}/${id}: provider error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      opts.onCapability?.(null);
    }
  };
  const metrics: Metric[] = [];
  const details: Record<string, string> = {};
  const add = (name: string, value: number, threshold: number) => metrics.push({ name, value: round(value), threshold, pass: value >= threshold });

  // Intent: score falls inside the expected band
  let inBand = 0;
  const intentCases = intentSet as IntentCase[];
  for (const c of intentCases) {
    const { neededByDays, ...rest } = c.input;
    const input: IntentInput = {
      buyerVerificationTier: 0, buyerPhoneVerified: false, buyerPriorEnquiries: 0, buyerPriorResponded: 0, ...rest,
      neededBy: neededByDays != null ? new Date(now.getTime() + neededByDays * DAY).toISOString() : null,
    };
    const r = await safe("intent", c.id, () => providers.intent.score(input));
    if (!r) { samples.intent!.push({ id: c.id, correct: false, confidence: 0, humanRouted: true }); continue; }
    const { output } = r;
    const ok = output.score >= c.band[0] && output.score <= c.band[1];
    if (ok) inBand++;
    else failures.push(`intent/${c.id}: score ${output.score} outside [${c.band}] (${output.reasons.join("; ")})`);
    samples.intent!.push({ id: c.id, correct: ok, confidence: r.confidence, humanRouted: r.confidence < REVIEW_THRESHOLDS.intent });
  }
  add("intentBandAccuracy", inBand / intentCases.length, THRESHOLDS.intentBandAccuracy);

  // Extraction: per expected field
  let fieldsOk = 0, fieldsTotal = 0;
  for (const c of extractionSet as ExtractCase[]) {
    const r = await safe("extract", c.id, () => providers.extractor.extract({ text: c.text, language: c.language ?? "en", categories: categories as ExtractListingInput["categories"] }));
    if (!r) { fieldsTotal += Object.keys(c.expect).length; samples.extract!.push({ id: c.id, correct: false, confidence: 0, humanRouted: true }); continue; }
    const { output } = r;
    let caseMiss = 0;
    const check = (field: string, ok: boolean, got: unknown) => {
      fieldsTotal++;
      if (ok) fieldsOk++; else { caseMiss++; failures.push(`extract/${c.id}: ${field} got ${JSON.stringify(got)}`); }
    };
    for (const [k, want] of Object.entries(c.expect)) {
      if (k === "titleIncludes") check("title", output.title.toLowerCase().includes((want as string).toLowerCase()), output.title);
      else if (k === "attributes") {
        for (const [ak, av] of Object.entries(want as Record<string, unknown>)) check(`attributes.${ak}`, output.attributes[ak] === av, output.attributes[ak]);
      } else check(k, (output as unknown as Record<string, unknown>)[k] === want, (output as unknown as Record<string, unknown>)[k]);
    }
    samples.extract!.push({ id: c.id, correct: caseMiss === 0, confidence: r.confidence, humanRouted: r.confidence < REVIEW_THRESHOLDS.extract });
  }
  add("extractionFieldAccuracy", fieldsOk / fieldsTotal, THRESHOLDS.extractionFieldAccuracy);

  // Moderation: block precision/recall; overall verdict accuracy reported for information
  let tp = 0, fp = 0, fn = 0, exact = 0, flagOk = 0, flagTotal = 0, scriptTp = 0, scriptFn = 0;
  const mod = (moderationSet as ModCase[]).filter((c) => !skipped(c, skip));
  for (const c of mod) {
    const r = await safe("moderate", c.id, () => providers.moderator.moderate({ text: c.text }));
    if (!r) {
      samples.moderate!.push({ id: c.id, correct: false, confidence: 0, humanRouted: true });
      if (c.verdict === "block") { fn++; if (c.tags?.some((t) => SCRIPT_TAGS.includes(t))) scriptFn++; }
      if (c.verdict === "block" && c.flags) flagTotal++;
      continue;
    }
    const { output } = r;
    if (output.verdict === c.verdict) exact++;
    const scripted = !!c.tags?.some((t) => SCRIPT_TAGS.includes(t));
    if (output.verdict === "block" && c.verdict === "block") { tp++; if (scripted) scriptTp++; }
    else if (output.verdict === "block") { fp++; failures.push(`moderate/${c.id}: false block "${c.text}"`); }
    else if (c.verdict === "block") { fn++; if (scripted) scriptFn++; failures.push(`moderate/${c.id}: missed block "${c.text}" -> ${output.verdict}`); }
    if (c.verdict === "block" && c.flags) {
      flagTotal++;
      if (output.verdict === "block" && c.flags.every((f) => output.flags.includes(f))) flagOk++;
      else if (output.verdict === "block") failures.push(`moderate/${c.id}: blocked with flags [${output.flags}] but expected [${c.flags}]`);
    }
    // "review" always reaches a human (ADR-003), whatever the confidence
    samples.moderate!.push({ id: c.id, correct: output.verdict === c.verdict, confidence: r.confidence, humanRouted: output.verdict === "review" || r.confidence < REVIEW_THRESHOLDS.moderate });
  }
  add("moderationBlockPrecision", tp + fp ? tp / (tp + fp) : 1, THRESHOLDS.moderationBlockPrecision);
  add("moderationBlockRecall", tp + fn ? tp / (tp + fn) : 1, THRESHOLDS.moderationBlockRecall);
  add("moderationFlagAccuracy", flagTotal ? flagOk / flagTotal : 1, THRESHOLDS.moderationFlagAccuracy);
  add("moderationScriptBlockRecall", scriptTp + scriptFn ? scriptTp / (scriptTp + scriptFn) : 1, THRESHOLDS.moderationScriptBlockRecall);
  details.moderationVerdictAccuracy = round(exact / mod.length).toString();

  for (const [name, cap, floor] of [["intentAutoAcceptAccuracy", "intent", THRESHOLDS.intentAutoAcceptAccuracy], ["extractionAutoAcceptAccuracy", "extract", THRESHOLDS.extractionAutoAcceptAccuracy], ["moderationAutoAcceptAccuracy", "moderate", THRESHOLDS.moderationAutoAcceptAccuracy]] as const) {
    const auto = samples[cap]!.filter((x) => !x.humanRouted);
    add(name, auto.length ? auto.filter((x) => x.correct).length / auto.length : 1, floor);
  }

  // Embeddings: cosine(anchor, positive) beats cosine(anchor, negative)
  const trips = embeddingSet as Triplet[];
  let margins = 0, tripOk = 0;
  for (const t of trips) {
    const { vectors: [a, p, n] } = { vectors: await providers.embedder.embed([t.anchor, t.positive, t.negative]) };
    const pos = cosine(a!, p!), neg = cosine(a!, n!);
    margins += pos - neg;
    if (pos > neg + 0.1) tripOk++;
    else failures.push(`embedding/${t.id}: pos ${pos.toFixed(2)} vs neg ${neg.toFixed(2)}`);
  }
  add("embeddingTripletAccuracy", tripOk / trips.length, THRESHOLDS.embeddingTripletAccuracy);
  details.embeddingMeanMargin = round(margins / trips.length).toString();

  // Photo drafts: hint-derived fields (all providers) + review routing; live-only checks skip without a key.
  const vision = visionSet as VisionCase[];
  const imageProvider = providers.imageExtractor ?? heuristicProviders.imageExtractor!;
  const liveVision = isLive("AI_PROVIDER", "anthropic");
  let vOk = 0, vTotal = 0, vReview = 0, liveOk = 0, liveTotal = 0;
  for (const c of vision) {
    const img = { bytes: syntheticPng(640, 480, c.fixture.pattern, c.fixture.a, c.fixture.b), mimeType: "image/png", width: 640, height: 480 };
    const r = await safe("extract_image", c.id, () => imageProvider.extract({ images: [img], hintText: c.hintText, language: c.language, categories: categories as ExtractListingInput["categories"] }));
    if (!r) { vTotal += Object.keys(c.expect).length; if (liveVision && c.live) liveTotal += (c.live.categorySlug ? 1 : 0) + (c.live.visualAttributesInclude?.length ?? 0); continue; }
    for (const [k, want] of Object.entries(c.expect)) {
      vTotal++;
      if ((r.output as unknown as Record<string, unknown>)[k] === want) vOk++; else failures.push(`vision/${c.id}: ${k} got ${JSON.stringify((r.output as unknown as Record<string, unknown>)[k])}`);
    }
    if (r.confidence < REVIEW_THRESHOLDS.extract_image) vReview++;
    if (liveVision && c.live) {
      if (c.live.categorySlug) { liveTotal++; if (r.output.categorySlug === c.live.categorySlug) liveOk++; else failures.push(`vision-live/${c.id}: category ${r.output.categorySlug}`); }
      for (const k of c.live.visualAttributesInclude ?? []) { liveTotal++; if (r.output.visualAttributes[k]) liveOk++; else failures.push(`vision-live/${c.id}: missing visualAttributes.${k}`); }
    }
  }
  add("visionHintFieldAccuracy", vTotal ? vOk / vTotal : 1, THRESHOLDS.visionHintFieldAccuracy);
  if (providers.imageExtractor === undefined || !liveVision) add("visionHeuristicNeedsReviewRate", vReview / vision.length, THRESHOLDS.visionHeuristicNeedsReviewRate);
  details.visionLive = liveVision ? `${liveOk}/${liveTotal}` : "skipped (set AI_PROVIDER=anthropic + ANTHROPIC_API_KEY)";

  // ASR: mock validates plumbing on sidecar transcripts; a live provider needs real recordings in evals/audio.
  const liveAsr = isLive("ASR_PROVIDER", "sarvam");
  let acc = 0, asrN = 0;
  for (const c of asrSet as AsrCase[]) {
    let audio: Uint8Array;
    if (asr.name === "mock") audio = mockAudio(c.reference);
    else if (liveAsr && c.audioFile && existsSync(new URL(`./audio/${c.audioFile}`, import.meta.url))) audio = readFileSync(new URL(`./audio/${c.audioFile}`, import.meta.url));
    else continue;
    const t = await asr.transcribe({ audio: { bytes: audio, mimeType: "audio/ogg" }, languageHint: c.language });
    const a = wordAccuracy(c.reference, t.output.text);
    acc += a; asrN++;
    if (a < THRESHOLDS.asrWordAccuracy) failures.push(`asr/${c.id}: word accuracy ${a.toFixed(2)} ("${t.output.text}")`);
  }
  if (asrN) add("asrWordAccuracy", acc / asrN, THRESHOLDS.asrWordAccuracy);
  else details.asrLive = "skipped (set ASR_PROVIDER=sarvam + SARVAM_API_KEY and add recordings under evals/audio)";

  return { metrics, failures, pass: metrics.every((m) => m.pass), details, samples, errors };
}
