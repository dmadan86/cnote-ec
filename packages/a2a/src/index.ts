// @cnote/a2a: ADR-020 agent-to-agent commerce (buyer agent <-> seller agent) and the external agent API. Flag A2A_ENABLED.
// PUBLIC CONTRACT. Guardrails: explicit opt-in mandates (auto-accept off by default, revocable, every change logged); a typed
// offer/counter/accept protocol with server-side bounds on BOTH sides; a deal exists only after each principal confirms (or
// auto-accepted within its bounds); no agent ever sees the counterparty's floor or ceiling; every agent action is visible to its principal.
export { isA2aEnabled, listActivity, limits, type Actor, type Via, type ActivityView } from "./common";
export {
  buyerMandateSchema, sellerMandateSchema, mandatePatchSchema, createBuyerMandate, createSellerMandate, updateMandate, setAutoAccept, pauseMandate, resumeMandate, revokeMandate,
  listMandates, getMandate, listMandateChanges, expireMandates, mandateProblem,
  type MandateView, type MandateChangeView, type BuyerMandateInput, type SellerMandateInput, type MandatePatch,
} from "./mandates";
export {
  startNegotiation, sendNegotiationMessage, getNegotiation, listNegotiations, confirmNegotiation, withdrawNegotiation, retryRealisation, finalise, expireNegotiations,
  withdrawOpenNegotiations, findCounterpartyMandate, adminGetNegotiation, adminListNegotiations, adminListMandates,
  type NegotiationView, type NegotiationSummary, type MessageView, type OfferView, type StartInput, type SendOptions,
} from "./negotiation";
export { advanceNegotiation, nextAgentAction, runMandate, runDueMandates, startNegotiationsForEnquiry, sweepStalled, type RunResult } from "./agents";
export { suspend, liftSuspension, listSuspensions, listAnomalies, assertNotSuspended, type SuspensionView, type SuspensionKind, type AnomalyView } from "./safety";
export { a2aMetrics, type A2aMetrics, type Range } from "./metrics";
export {
  step, checkOwnBounds, withinAutoAccept, buyerAgentMove, sellerAgentMove, messageSchema, offerSchema, fingerprint, validityProblem, MESSAGE_TYPES,
  type Offer, type OfferInput, type ProtocolMessage, type ProtocolMessageInput, type State, type Status, type Side, type Private, type BuyerPrivate, type SellerPrivate, type StepResult, type StepError,
} from "./protocol";
export { worker } from "./worker";
