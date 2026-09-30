import { AnthropicImageExtractor, AnthropicIntentScorer, AnthropicListingExtractor, AnthropicModerator, createAnthropicClient, type MessagesClient } from "./anthropic";
import { localEmbedder } from "./embedder";
import { extractListingHeuristic } from "./heuristic/extract";
import { HEURISTIC_MODEL, scoreIntentHeuristic } from "./heuristic/intent";
import { moderateHeuristic } from "./heuristic/moderate";
import { extractFromImagesHeuristic } from "./vision";
import type { ImageListingExtractor, ListingExtractor, IntentScorer, Moderator, ProviderResult, Providers } from "./types";

export const heuristicProviders: Providers = {
  intent: { score: async (i) => scoreIntentHeuristic(i) },
  extractor: { extract: async (i) => extractListingHeuristic(i) },
  moderator: { moderate: async (i) => moderateHeuristic(i) },
  imageExtractor: { extract: async (i) => extractFromImagesHeuristic(i) },
  embedder: localEmbedder,
};

/** Runs the vendor call; on ANY failure (API error, timeout, bad JSON) answers with the heuristic instead (ADR-008). */
async function withFallback<I, O>(
  primary: (i: I) => Promise<ProviderResult<O>>,
  fallback: (i: I) => Promise<ProviderResult<O>>,
  i: I,
): Promise<ProviderResult<O>> {
  try {
    return await primary(i);
  } catch (err) {
    console.warn("[ai] anthropic call failed, using heuristic fallback:", err instanceof Error ? err.message : err);
    const r = await fallback(i);
    return { ...r, provider: "heuristic-fallback", modelId: HEURISTIC_MODEL };
  }
}

/** Anthropic for reasoning capabilities; embeddings stay local (Anthropic has no embeddings API). */
export function anthropicProviders(client: MessagesClient = createAnthropicClient(), fallback = true): Providers {
  const intent = new AnthropicIntentScorer(client);
  const extractor = new AnthropicListingExtractor(client);
  const moderator = new AnthropicModerator(client);
  const imageExtractor = new AnthropicImageExtractor(client);
  const h = heuristicProviders;
  const wrap = <I, O>(p: (i: I) => Promise<ProviderResult<O>>, f: (i: I) => Promise<ProviderResult<O>>) =>
    fallback ? (i: I) => withFallback(p, f, i) : p;
  return {
    intent: { score: wrap((i) => intent.score(i), (i) => h.intent.score(i)) } satisfies IntentScorer,
    extractor: { extract: wrap((i) => extractor.extract(i), (i) => h.extractor.extract(i)) } satisfies ListingExtractor,
    moderator: { moderate: wrap((i) => moderator.moderate(i), (i) => h.moderator.moderate(i)) } satisfies Moderator,
    imageExtractor: { extract: wrap((i) => imageExtractor.extract(i), async (i) => extractFromImagesHeuristic(i)) } satisfies ImageListingExtractor,
    embedder: localEmbedder,
  };
}

let cached: { name: string; providers: Providers } | null = null;
let override: Providers | null = null;

/** Picks by AI_PROVIDER ("heuristic" default | "anthropic"), read per call so tests/ops can flip it. */
export function getProviders(): Providers {
  if (override) return override;
  const name = process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "heuristic";
  if (cached?.name !== name) cached = { name, providers: name === "anthropic" ? anthropicProviders() : heuristicProviders };
  return cached.providers;
}

/** Test hook: inject providers (null restores env-based selection). */
export function setProvidersForTests(p: Providers | null) { override = p; cached = null; }
