// @cnote/ondc: ADR-017 ONDC seller-network-participant adapter (Beckn). Flag ONDC_ENABLED (default false).
// PUBLIC CONTRACT. Not live on the network until ADR-021 (needs ADR-013 dispute capacity).
export { loadConfig, isEnabled, configStatus, REGISTRY_URLS, type OndcConfig, type ConfigStatus, type OndcEnv } from "./config";
export {
  buildAuthHeader, parseAuthHeader, verifyAuthSignature, blake2bDigest, signingString, decryptChallenge, encryptChallenge, signRequestId, siteVerificationHtml,
  generateSigningKeyPair, generateEncryptionKeyPair, edPublicFromPrivate, OndcCryptoError, type ParsedAuthHeader, type VerifyResult,
} from "./crypto";
export { getRegistry, setRegistry, setFetch, HttpRegistry, isEntryActive, parseLookupResponse, type RegistryPort, type RegistryEntry, type FetchLike } from "./registry";
export { INBOUND_ACTIONS, ACK, nack, ERROR_CODES, type InboundAction, type CallbackAction } from "./beckn";
export { buildProvider, buildCatalog, listingToItem, ineligibleReason, paiseToDecimal, decimalToPaise, MIN_VERIFICATION_TIER, type BecknProvider, type BecknItem, type IneligibleReason } from "./mapping";
export { setCatalogSource, type CatalogSource } from "./source";
export { setOrderSink, type OrderSink, type ExternalOrderInput } from "./sink";
export {
  TERMS_VERSION, getSellerState, connectSeller, disconnectSeller, setListingOptIn, listSellerListingOptIns,
  type OndcSellerState, type ListingOptInRow, type SellerActor,
} from "./sellers";
export { providerFor, allProviders, catalogForIntent, publishCatalog, publishAllCatalogs, type PublishResult } from "./catalog";
export { receiveInbound, verifyGateway, MAX_BODY_BYTES, type InboundResult } from "./inbound";
export { handleOnSubscribe, siteVerification } from "./subscribe";
export { listSellerOrders, acceptOrder, rejectOrder, getOndcOrderSeller, type OndcOrderView, type OndcOrderStatus } from "./orders";
export { adminOverview, listMessages, listFailedCallbacks, replayCallback, purgeOldMessages, purgeOndcOrderPayloads, redactBody, type AdminOverview, type MessageLogRow } from "./admin";
export { worker } from "./worker";
export { enquiryOrderSink, wireOndcOrderSink } from "./enquiry-sink";
// ADR-021 live participation
export { isKilled, getKillSwitch, setKillSwitch, resumePending, CERT_ITEMS, getCertState, setCertItem, type KillSwitchState, type CertItemId } from "./killswitch";
export { onOrderStatusChanged, onOrderFulfilmentUpdated, STAGE_MAP, FULFILMENT_MAP, FULFILMENT_STATES, type FulfilmentState } from "./fulfilment";
export {
  handleIssue, handleIssueStatus, onDisputeEscalated, onDisputeResolved, resolveIssueManually, escalateOverdueIssues, purgeIssuePayloads, listIssues, disputeTypeFor, parseIsoDuration,
  detMessageId, listSellerIssues, getSellerIssue, type SellerIssueView, type IssueView, type ManualResolution, type ResolutionAction,
} from "./igm";
export { ondcEvaluation, type OndcEvaluation } from "./evaluation";
export { readiness, type Readiness, type ReadinessItem } from "./readiness";
