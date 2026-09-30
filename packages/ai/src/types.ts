import type {
  ExtractListingFromImagesInput, ExtractListingFromImagesOutput, ExtractListingInput, ExtractListingOutput, IntentInput, IntentOutput, ModerateInput, ModerateOutput, TranscribeInput, TranscribeOutput,
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
export interface ImageListingExtractor { extract(input: ExtractListingFromImagesInput): Promise<ProviderResult<ExtractListingFromImagesOutput>> }
/** ASR port (adapters: sarvam, mock). Provider errors propagate so queue consumers can retry. */
export interface SpeechToText { readonly name: string; transcribe(input: TranscribeInput): Promise<ProviderResult<TranscribeOutput>> }
export interface Moderator { moderate(input: ModerateInput): Promise<ProviderResult<ModerateOutput>> }
export interface Embedder { version: string; embed(texts: string[]): Promise<number[][]> }

export interface Providers {
  intent: IntentScorer;
  extractor: ListingExtractor;
  moderator: Moderator;
  /** optional: providers built before photo drafts existed fall back to the heuristic */
  imageExtractor?: ImageListingExtractor;
  embedder: Embedder;
}
