// Remote AI transport (ADR-018): the same provider ports as the in-process registry, implemented over the language-neutral
// HTTP contract of apps/ai-service (docs/design/scale.md, docs/design/ai-service.openapi.json). AI_TRANSPORT=http selects it.
//
// What crosses the wire is the PROVIDER call (input -> ProviderResult). Decision logging, review routing, redaction of the
// audit copy and confidence thresholds stay in this package (runLogged & co.), so the service needs no database and is the
// single egress point to model vendors. On availability failures the caller falls back to the in-process heuristic
// (AI_REMOTE_FALLBACK=heuristic, the default) and tags the result "heuristic-fallback"; 4xx answers (bad input, bad
// credentials) always surface instead of being masked.
import type { DocumentExtractor, ExtractDocumentInput, ExtractDocumentOutput } from "./document";
import type { BriefDisputeInput, BriefDisputeOutput, DisputeBriefProvider } from "./disputes";
import type { DispatchInspector, InspectDispatchInput, InspectDispatchOutput } from "./inspection";
import type {
  DraftQuoteInput, DraftQuoteOutput, NormaliseQuotesInput, NormaliseQuotesOutput, ProposeCounterInput, ProposeCounterOutput, QuoteProviders,
} from "./quotes";
import { ServiceClient, ServiceUnavailableError, type ServiceClientOptions } from "./service-client";
import type { SpeechToText } from "./types";
import type { Embedder, ProviderResult, Providers } from "./types";
import type {
  ExtractListingFromImagesInput, ExtractListingFromImagesOutput, ExtractListingInput, ExtractListingOutput, IntentInput, IntentOutput, ModerateInput,
  ModerateOutput, TranscribeInput, TranscribeOutput,
} from "./index";

export const AI_SERVICE_AUDIENCE = "ai-service";

/**
 * The wire contract: one POST endpoint per capability. `retry` = safe to repeat (pure function of the input, no side
 * effects). Transcription is the exception: it is metered per audio second and slow, so a lost response is retried by the
 * queue consumer (which owns idempotency), never by the transport.
 */
export const AI_CAPABILITIES = {
  scoreIntent: { path: "/v1/score-intent", retry: true, summary: "Buyer-intent score for an enquiry" },
  embed: { path: "/v1/embed", retry: true, summary: "Embeddings in the platform vector space" },
  extractListing: { path: "/v1/extract-listing", retry: true, summary: "Free text to structured listing draft" },
  extractListingFromImages: { path: "/v1/extract-listing-from-images", retry: true, summary: "Product photos to structured listing draft" },
  transcribe: { path: "/v1/transcribe", retry: false, summary: "Audio to transcript (ASR)" },
  moderate: { path: "/v1/moderate", retry: true, summary: "Prohibited-category / policy moderation" },
  extractDocument: { path: "/v1/extract-document", retry: true, summary: "KYC document image to fields and forgery signals" },
  inspectDispatch: { path: "/v1/inspect-dispatch", retry: true, summary: "Dispatch photos vs order expectation" },
  briefDispute: { path: "/v1/brief-dispute", retry: true, summary: "Dispute evidence to adjudicator brief" },
  draftQuote: { path: "/v1/draft-quote", retry: true, summary: "Draft a seller quote for an enquiry" },
  normaliseQuotes: { path: "/v1/normalise-quotes", retry: true, summary: "Normalise competing quotes to comparable terms" },
  proposeCounter: { path: "/v1/propose-counter", retry: true, summary: "Propose a buyer counter-offer" },
} as const;
export type AiCapabilityName = keyof typeof AI_CAPABILITIES;

export type AiTransport = "inproc" | "http";
/** AI_TRANSPORT=inproc (default) | http, read per call like AI_PROVIDER. */
export function aiTransport(env: NodeJS.ProcessEnv = process.env): AiTransport {
  return env.AI_TRANSPORT === "http" ? "http" : "inproc";
}
/** AI_REMOTE_FALLBACK=heuristic (default) | none. */
export function remoteFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_REMOTE_FALLBACK !== "none";
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Builds the client from AI_SERVICE_URL, AI_SERVICE_TOKEN_SECRET (comma list allows rotation), AI_SERVICE_TIMEOUT_MS, ... */
export function aiServiceClientFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<ServiceClientOptions> = {}): ServiceClient {
  const baseUrl = env.AI_SERVICE_URL;
  const secret = env.AI_SERVICE_TOKEN_SECRET;
  if (!baseUrl || !secret) throw new Error("AI_TRANSPORT=http requires AI_SERVICE_URL and AI_SERVICE_TOKEN_SECRET");
  return new ServiceClient({
    name: "ai-service", baseUrl, secret, audience: AI_SERVICE_AUDIENCE, issuer: env.SERVICE_NAME || "cnote",
    timeoutMs: num(env.AI_SERVICE_TIMEOUT_MS, 15_000), retries: num(env.AI_SERVICE_RETRIES, 2), backoffMs: num(env.AI_SERVICE_BACKOFF_MS, 150),
    ...extra,
  });
}

let sharedClient: ServiceClient | null = null;
/** One client (and so one circuit breaker) per process. */
export function sharedAiServiceClient(): ServiceClient {
  return (sharedClient ??= aiServiceClientFromEnv());
}
export function resetSharedAiServiceClientForTests() { sharedClient = null; }

function valid<O>(r: unknown, path: string): ProviderResult<O> {
  const p = r as Partial<ProviderResult<O>> | null;
  if (!p || typeof p !== "object" || p.output === undefined || typeof p.confidence !== "number" || typeof p.provider !== "string") {
    throw new ServiceUnavailableError(`ai-service ${path}: malformed ProviderResult`);
  }
  return p as ProviderResult<O>;
}

/**
 * One capability call. `local` is the in-process fallback used ONLY when the service is unavailable (breaker open, network,
 * timeout, 5xx); pass null to make failures propagate (queue consumers retry them).
 */
export function remoteCall<I, O>(
  client: ServiceClient,
  cap: AiCapabilityName,
  local: ((i: I) => Promise<ProviderResult<O>>) | null,
): (i: I) => Promise<ProviderResult<O>> {
  const { path, retry } = AI_CAPABILITIES[cap];
  return async (input) => {
    try {
      const { data } = await client.request<ProviderResult<O>>("POST", path, { input }, { retry });
      return valid<O>(data, path);
    } catch (err) {
      if (!local || !(err instanceof ServiceUnavailableError)) throw err;
      console.warn(`[ai] ai-service unavailable for ${cap} (${err.message}); using in-process heuristic`);
      return { ...(await local(input)), provider: "heuristic-fallback" };
    }
  };
}

/** Embedder over the wire. `version` is the platform embedder version (identical on both sides; a mismatch is logged). */
export function remoteEmbedder(client: ServiceClient, local: Embedder, useFallback: boolean): Embedder {
  const call = remoteCall<{ texts: string[] }, { vectors: number[][]; version: string }>(
    client, "embed", useFallback ? async ({ texts }) => ({ output: { vectors: await local.embed(texts), version: local.version }, confidence: 1, provider: "heuristic", modelId: "local", promptVersion: "-" }) : null,
  );
  return {
    version: local.version,
    async embed(texts) {
      const r = await call({ texts });
      if (r.output.version !== local.version) console.warn(`[ai] embedder version mismatch: service ${r.output.version} vs local ${local.version}`);
      if (r.output.vectors.length !== texts.length) throw new ServiceUnavailableError("ai-service /v1/embed: vector count mismatch");
      return r.output.vectors;
    },
  };
}

export function remoteProviders(client: ServiceClient, local: Providers, useFallback = true): Providers {
  const fb = <I, O>(f: (i: I) => Promise<ProviderResult<O>>) => (useFallback ? f : null);
  return {
    intent: { score: remoteCall<IntentInput, IntentOutput>(client, "scoreIntent", fb((i) => local.intent.score(i))) },
    extractor: { extract: remoteCall<ExtractListingInput, ExtractListingOutput>(client, "extractListing", fb((i) => local.extractor.extract(i))) },
    moderator: { moderate: remoteCall<ModerateInput, ModerateOutput>(client, "moderate", fb((i) => local.moderator.moderate(i))) },
    imageExtractor: {
      extract: remoteCall<ExtractListingFromImagesInput, ExtractListingFromImagesOutput>(client, "extractListingFromImages", fb((i) => local.imageExtractor!.extract(i))),
    },
    embedder: remoteEmbedder(client, local.embedder, useFallback),
  };
}

/** No local fallback: an ASR mock must never masquerade as a transcript. Errors propagate for the queue retry. */
export function remoteSpeechToText(client: ServiceClient): SpeechToText {
  return { name: "remote", transcribe: remoteCall<TranscribeInput, TranscribeOutput>(client, "transcribe", null) };
}

export function remoteDocumentExtractor(client: ServiceClient, local: DocumentExtractor | null): DocumentExtractor {
  return { extract: remoteCall<ExtractDocumentInput, ExtractDocumentOutput>(client, "extractDocument", local && ((i) => local.extract(i))) };
}
export function remoteDispatchInspector(client: ServiceClient, local: DispatchInspector | null): DispatchInspector {
  return { inspect: remoteCall<InspectDispatchInput, InspectDispatchOutput>(client, "inspectDispatch", local && ((i) => local.inspect(i))) };
}
export function remoteDisputeProvider(client: ServiceClient, local: DisputeBriefProvider | null): DisputeBriefProvider {
  return { brief: remoteCall<BriefDisputeInput, BriefDisputeOutput>(client, "briefDispute", local && ((i) => local.brief(i))) };
}
export function remoteQuoteProviders(client: ServiceClient, local: QuoteProviders | null): QuoteProviders {
  return {
    drafter: { draft: remoteCall<DraftQuoteInput, DraftQuoteOutput>(client, "draftQuote", local && ((i) => local.drafter.draft(i))) },
    normaliser: { normalise: remoteCall<NormaliseQuotesInput, NormaliseQuotesOutput>(client, "normaliseQuotes", local && ((i) => local.normaliser.normalise(i))) },
    countering: { propose: remoteCall<ProposeCounterInput, ProposeCounterOutput>(client, "proposeCounter", local && ((i) => local.countering.propose(i))) },
  };
}
