// The in-process implementations the service exposes over HTTP: exactly the provider ports @cnote/ai selects from AI_PROVIDER /
// ASR_PROVIDER. Decision logging, review routing and audit redaction stay with the CALLER (packages/ai runLogged); this
// process holds the vendor credentials and needs no database.
import {
  anthropicDisputeProvider, getDispatchInspector, getDocumentExtractor, getProviders, getQuoteProviders, getSpeechToText, heuristicDisputeProvider,
  type ProviderResult,
} from "@cnote/ai";
import { AI_CAPABILITIES, type AiCapabilityName } from "@cnote/ai/remote";

export type CapabilityHandler = (input: any) => Promise<ProviderResult<unknown>>;
export type CapabilityHandlers = Record<AiCapabilityName, CapabilityHandler>;

let disputeProvider: ReturnType<typeof anthropicDisputeProvider> | null = null;
const disputes = () =>
  process.env.AI_PROVIDER === "anthropic" ? (disputeProvider ??= anthropicDisputeProvider()) : heuristicDisputeProvider;

export function inProcessHandlers(): CapabilityHandlers {
  return {
    scoreIntent: (i) => getProviders().intent.score(i),
    embed: async (i: { texts: string[] }) => {
      const e = getProviders().embedder;
      return { output: { vectors: await e.embed(i.texts), version: e.version }, confidence: 1, provider: "local", modelId: e.version, promptVersion: "-" };
    },
    extractListing: (i) => getProviders().extractor.extract(i),
    extractListingFromImages: (i) => getProviders().imageExtractor!.extract(i),
    transcribe: (i) => getSpeechToText().transcribe(i),
    moderate: (i) => getProviders().moderator.moderate(i),
    extractDocument: (i) => getDocumentExtractor().extract(i),
    inspectDispatch: (i) => getDispatchInspector().inspect(i),
    briefDispute: (i) => disputes().brief(i),
    draftQuote: (i) => getQuoteProviders().drafter.draft(i),
    normaliseQuotes: (i) => getQuoteProviders().normaliser.normalise(i),
    proposeCounter: (i) => getQuoteProviders().countering.propose(i),
  };
}

export const CAPABILITY_NAMES = Object.keys(AI_CAPABILITIES) as AiCapabilityName[];
