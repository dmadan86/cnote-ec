import type {
  ExtractListingInput, ExtractListingOutput, IntentInput, IntentOutput, ModerateInput, ModerateOutput,
} from "./index";

/** What a provider returns; the orchestrator adds timing, audit and review routing. */
export interface ProviderResult<T> {
  output: T;
  confidence: number; // 0..1
  provider: string; // "heuristic" | "anthropic" | "heuristic-fallback"
  modelId: string;
  promptVersion: string;
}

export interface IntentScorer { score(input: IntentInput): Promise<ProviderResult<IntentOutput>> }
export interface ListingExtractor { extract(input: ExtractListingInput): Promise<ProviderResult<ExtractListingOutput>> }
export interface Moderator { moderate(input: ModerateInput): Promise<ProviderResult<ModerateOutput>> }
export interface Embedder { version: string; embed(texts: string[]): Promise<number[][]> }

export interface Providers {
  intent: IntentScorer;
  extractor: ListingExtractor;
  moderator: Moderator;
  embedder: Embedder;
}
