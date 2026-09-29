// Eval harness (ADR-008): golden sets in ./data, per-capability metrics, thresholds that gate CI.
import { cosine } from "../src/index";
import type { ExtractListingInput, ExtractListingOutput, IntentInput } from "../src/index";
import { getProviders } from "../src/registry";
import type { Providers } from "../src/types";
import categories from "./data/categories.json";
import embeddingSet from "./data/embedding.json";
import extractionSet from "./data/extraction.json";
import intentSet from "./data/intent.json";
import moderationSet from "./data/moderation.json";

export const THRESHOLDS = {
  intentBandAccuracy: 0.85,
  extractionFieldAccuracy: 0.85,
  moderationBlockPrecision: 0.95,
  moderationBlockRecall: 0.9,
  embeddingTripletAccuracy: 0.9,
} as const;

export interface Metric { name: string; value: number; threshold: number; pass: boolean }
export interface EvalReport { metrics: Metric[]; failures: string[]; pass: boolean; details: Record<string, string> }

const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 1000) / 1000;

interface IntentCase { id: string; input: Partial<IntentInput> & { title: string; requirement: string; neededByDays?: number }; band: [number, number] }
interface ExtractCase { id: string; text: string; language?: ExtractListingInput["language"]; expect: Partial<ExtractListingOutput> & { titleIncludes?: string } }
interface ModCase { id: string; text: string; verdict: "allow" | "review" | "block" }
interface Triplet { id: string; anchor: string; positive: string; negative: string }

export async function runEvals(providers: Providers = getProviders(), now = new Date()): Promise<EvalReport> {
  const failures: string[] = [];
  const metrics: Metric[] = [];
  const details: Record<string, string> = {};
  const add = (name: string, value: number, threshold: number) => metrics.push({ name, value: round(value), threshold, pass: value >= threshold });

  // Intent: score falls inside the expected band
  let inBand = 0;
  for (const c of intentSet as IntentCase[]) {
    const { neededByDays, ...rest } = c.input;
    const input: IntentInput = {
      buyerVerificationTier: 0, buyerPhoneVerified: false, buyerPriorEnquiries: 0, buyerPriorResponded: 0, ...rest,
      neededBy: neededByDays != null ? new Date(now.getTime() + neededByDays * DAY).toISOString() : null,
    };
    const { output } = await providers.intent.score(input);
    if (output.score >= c.band[0] && output.score <= c.band[1]) inBand++;
    else failures.push(`intent/${c.id}: score ${output.score} outside [${c.band}] (${output.reasons.join("; ")})`);
  }
  add("intentBandAccuracy", inBand / (intentSet as IntentCase[]).length, THRESHOLDS.intentBandAccuracy);

  // Extraction: per expected field
  let fieldsOk = 0, fieldsTotal = 0;
  for (const c of extractionSet as ExtractCase[]) {
    const { output } = await providers.extractor.extract({ text: c.text, language: c.language ?? "en", categories: categories as ExtractListingInput["categories"] });
    const check = (field: string, ok: boolean, got: unknown) => {
      fieldsTotal++;
      if (ok) fieldsOk++; else failures.push(`extract/${c.id}: ${field} got ${JSON.stringify(got)}`);
    };
    for (const [k, want] of Object.entries(c.expect)) {
      if (k === "titleIncludes") check("title", output.title.toLowerCase().includes((want as string).toLowerCase()), output.title);
      else if (k === "attributes") {
        for (const [ak, av] of Object.entries(want as Record<string, unknown>)) check(`attributes.${ak}`, output.attributes[ak] === av, output.attributes[ak]);
      } else check(k, (output as unknown as Record<string, unknown>)[k] === want, (output as unknown as Record<string, unknown>)[k]);
    }
  }
  add("extractionFieldAccuracy", fieldsOk / fieldsTotal, THRESHOLDS.extractionFieldAccuracy);

  // Moderation: block precision/recall; overall verdict accuracy reported for information
  let tp = 0, fp = 0, fn = 0, exact = 0;
  const mod = moderationSet as ModCase[];
  for (const c of mod) {
    const { output } = await providers.moderator.moderate({ text: c.text });
    if (output.verdict === c.verdict) exact++;
    if (output.verdict === "block" && c.verdict === "block") tp++;
    else if (output.verdict === "block") { fp++; failures.push(`moderate/${c.id}: false block "${c.text}"`); }
    else if (c.verdict === "block") { fn++; failures.push(`moderate/${c.id}: missed block "${c.text}" -> ${output.verdict}`); }
  }
  add("moderationBlockPrecision", tp + fp ? tp / (tp + fp) : 1, THRESHOLDS.moderationBlockPrecision);
  add("moderationBlockRecall", tp + fn ? tp / (tp + fn) : 1, THRESHOLDS.moderationBlockRecall);
  details.moderationVerdictAccuracy = round(exact / mod.length).toString();

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

  return { metrics, failures, pass: metrics.every((m) => m.pass), details };
}
