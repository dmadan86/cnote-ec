// Account sync (pure part). The logic moved to @cnote/consent so the seller app shares it; this module keeps the web import path.
export { reconcileAccountConsent, requestedActionFor, type AccountConsent, type LedgerState, type SyncDecision } from "@cnote/consent";
