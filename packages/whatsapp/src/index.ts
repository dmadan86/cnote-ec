// @cnote/whatsapp: WhatsApp Business Platform channel (ADR-004 seller onboarding, ADR-010 consent).
// PUBLIC CONTRACT. See docs/design/whatsapp-channel.md.
export { worker } from "./worker";
export { handleWebhook, handleInboundJob, processInboundMessage, applyStatus, type WebhookResult } from "./inbound";
export { verifyChallenge, verifySignature, signBody } from "./signature";
export { parseWebhook } from "./parse";
export {
  getWhatsAppProvider, setWhatsAppProvider, metaCloudProvider, mockProvider, WhatsAppError, OUTSIDE_WINDOW_CODE,
  type WhatsAppProvider, type MockWhatsAppProvider, type SentRecord,
} from "./provider";
export { sendToPhone, type OutboundRequest, type OutboundOutcome } from "./outbound";
export { purgeWhatsAppMessages } from "./retention";
export { isWithinWindow, windowUntilFor, extendWindow } from "./window";
export { isOptOut, isOptIn } from "./keywords";
export { transition, initialState, coerceState, parseLocation, type FlowState, type Step, type Input, type Effect } from "./machine";
export { whatsappTemplateDefinitions, HI_DEFAULTS, LANGUAGES, type Lang } from "./copy";
export { setWhatsAppPorts, type WhatsAppPorts, type DraftedListing } from "./ports";
export { listContacts, getContactMessages, resetContact, listInboundDeadLetters, replayInboundDeadLetter, type ContactRow, type MessageRow, type DeadInbound } from "./admin";
export { WINDOW_MS, RETENTION_DAYS, TEMPLATE_COST_PAISE } from "./config";
export type { InboundJob, InboundMessage, StatusUpdate } from "./types";
