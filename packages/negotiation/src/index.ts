// @cnote/negotiation: ADR-014 seller quote-assist agent + buyer comparison/counter assist. Flag QUOTE_ASSIST_ENABLED.
// PUBLIC CONTRACT. Guardrails: agents never commit either party (a draft becomes a Quote only on seller approval; a counter is
// sent only when the buyer sends it), every action lands in the AgentActionLog, and price bounds are enforced server-side.
export { isQuoteAssistEnabled, listAgentActions, type AgentAction, type AgentActionView, type Actor } from "./common";
export {
  listPriceBook, getPriceBookEntry, upsertPriceBookEntry, seedPriceBookFromListings, selectPriceBookForRfq, priceBookInputSchema, type PriceBookView, type PriceBookInput,
} from "./pricebook";
export { generateDraft, requestDraft, getDraftForMatch, approveDraft, discardDraft, approveDraftFromChannel, draftEditsSchema, type QuoteDraftView, type DraftEdits } from "./draft";
export {
  getBuyerBounds, setBuyerBounds, compareQuotes, proposeCounterOffer, sendCounterOffer, discardCounterOffer, getCounterProposal, composeCounterMessage,
  type BuyerBoundsView, type ComparisonRow, type ComparisonView, type CounterProposalView, type CounterEdits,
} from "./compare";
export { draftMetrics, timeToFirstQuote, type DraftMetrics, type TimeToFirstQuote, type Cohort, type Range } from "./metrics";
export {
  checkSellerQuote, checkBuyerCounter, fallbackCounter, landedPerUnit, rankQuotes, priceBookProblems, buyerBoundsProblems, MIN_COUNTER_RATIO, DEFAULT_FLOOR_RATIO,
  type PriceTier, type BuyerBoundsInput, type BoundsResult, type Landed,
} from "./bounds";
export { worker, DRAFT_TOPIC } from "./worker";
