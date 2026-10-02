import { defaultModels, AnthropicImageExtractor, AnthropicIntentScorer, AnthropicListingExtractor, AnthropicModerator, createAnthropicClient, type MessagesClient, type ModelSet } from "./anthropic";
import { localEmbedder } from "./embedder";
import { extractListingHeuristic } from "./heuristic/extract";
import { HEURISTIC_MODEL, scoreIntentHeuristic } from "./heuristic/intent";
import { moderateHeuristic } from "./heuristic/moderate";
import { extractFromImagesHeuristic } from "./vision";
import { aiTransport, remoteFallbackEnabled, remoteProviders, sharedAiServiceClient } from "./remote";
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
export function anthropicProviders(client: MessagesClient = createAnthropicClient(), fallback = true, models: ModelSet = defaultModels()): Providers {
  const intent = new AnthropicIntentScorer(client, models);
  const extractor = new AnthropicListingExtractor(client, models);
  const moderator = new AnthropicModerator(client, models);
  const imageExtractor = new AnthropicImageExtractor(client, models);
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
let cachedRemote: Providers | null = null;
let override: Providers | null = null;

/** Picks by AI_PROVIDER ("heuristic" default | "anthropic"), read per call so tests/ops can flip it. */
export function getProviders(): Providers {
  if (override) return override;
  // ADR-018: AI_TRANSPORT=http routes provider calls to apps/ai-service (breaker + heuristic fallback); default in-process.
  if (aiTransport() === "http") return (cachedRemote ??= remoteProviders(sharedAiServiceClient(), heuristicProviders, remoteFallbackEnabled()));
  const name = process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "heuristic";
  if (cached?.name !== name) cached = { name, providers: name === "anthropic" ? anthropicProviders() : heuristicProviders };
  return cached.providers;
}

let shadowOverride: Providers | null = null;
let cachedShadow: { key: string; providers: Providers | null } | null = null;

/**
 * Shadow mode (ADR-008): AI_SHADOW_PROVIDER ("anthropic" | "heuristic") runs a candidate beside the live provider; its
 * decisions are logged with shadow=true and never reach users. AI_SHADOW_MODEL_REASONING / AI_SHADOW_MODEL_FAST pick the
 * candidate models. No heuristic fallback here: a failing candidate must show up as an error, not be masked.
 * Returns null when unset, or when it would just repeat the live provider.
 */
export function getShadowProviders(): Providers | null {
  if (shadowOverride) return shadowOverride;
  const name = process.env.AI_SHADOW_PROVIDER;
  if (name !== "anthropic" && name !== "heuristic") return null;
  const models: ModelSet = {
    reasoning: process.env.AI_SHADOW_MODEL_REASONING || defaultModels().reasoning,
    fast: process.env.AI_SHADOW_MODEL_FAST || defaultModels().fast,
  };
  const live = process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "heuristic";
  const sameAsLive = name === live && models.reasoning === defaultModels().reasoning && models.fast === defaultModels().fast;
  if (sameAsLive) return null;
  const key = JSON.stringify([name, models]);
  if (cachedShadow?.key !== key) cachedShadow = { key, providers: name === "anthropic" ? anthropicProviders(createAnthropicClient(), false, models) : heuristicProviders };
  return cachedShadow.providers;
}

/** Test hook: inject providers (null restores env-based selection). */
export function setProvidersForTests(p: Providers | null) { override = p; cached = null; cachedRemote = null; }

/** Test hook: inject candidate providers for shadow mode (null restores env-based selection). */
export function setShadowProvidersForTests(p: Providers | null) { shadowOverride = p; cachedShadow = null; }
