// Beckn / ONDC message shapes (ADR-017): context, ACK/NACK envelopes and light zod validation of what we consume.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OndcConfig } from "./config";

export const INBOUND_ACTIONS = ["search", "select", "init", "confirm", "status", "cancel", "issue", "issue_status"] as const;
export type InboundAction = (typeof INBOUND_ACTIONS)[number];
export type CallbackAction = `on_${InboundAction}`;
export const callbackOf = (a: InboundAction): CallbackAction => `on_${a}`;
export const isInboundAction = (a: string): a is InboundAction => (INBOUND_ACTIONS as readonly string[]).includes(a);

export const contextSchema = z.object({
  domain: z.string().min(1).max(40),
  country: z.string().max(10).optional(),
  city: z.string().max(20).optional(),
  action: z.string().min(1).max(30),
  core_version: z.string().max(20).optional(),
  bap_id: z.string().min(1).max(255),
  bap_uri: z.string().min(1).max(500),
  bpp_id: z.string().max(255).optional(),
  bpp_uri: z.string().max(500).optional(),
  transaction_id: z.string().min(1).max(100),
  message_id: z.string().min(1).max(100),
  timestamp: z.string().max(40),
  ttl: z.string().max(20).optional(),
}).loose();
export type BecknContext = z.infer<typeof contextSchema>;

const qty = z.object({ count: z.number().int().positive().max(10_000_000) });
const orderItem = z.object({ id: z.string().min(1).max(100), quantity: z.object({ count: z.number().int().positive().max(10_000_000).optional(), selected: qty.optional() }).loose().optional(), fulfillment_id: z.string().optional() }).loose();

export const envelopeSchema = z.object({ context: contextSchema, message: z.record(z.string(), z.unknown()) });

export const searchMessage = z.object({
  intent: z.object({
    item: z.object({ descriptor: z.object({ name: z.string().max(200).optional() }).loose().optional() }).loose().optional(),
    category: z.object({ id: z.string().max(100).optional() }).loose().optional(),
    provider: z.object({ id: z.string().max(100).optional() }).loose().optional(),
  }).loose().optional(),
});
export const orderMessage = z.object({
  order: z.object({
    id: z.string().max(100).optional(),
    provider: z.object({ id: z.string().min(1).max(100) }).loose(),
    items: z.array(orderItem).min(1).max(100),
    fulfillments: z.array(z.record(z.string(), z.unknown())).optional(),
    billing: z.record(z.string(), z.unknown()).optional(),
    payment: z.record(z.string(), z.unknown()).optional(),
    quote: z.record(z.string(), z.unknown()).optional(),
  }).loose(),
});
const igmText = z.string().max(4000).optional();
/** ONDC IGM `issue` message (light validation of what we consume). */
export const issueMessage = z.object({
  issue: z.object({
    id: z.string().min(1).max(100),
    category: z.string().min(1).max(50),
    sub_category: z.string().max(50).optional(),
    issue_type: z.string().max(20).optional(),
    status: z.string().max(20).optional(),
    order_details: z.object({ id: z.string().min(1).max(100) }).loose(),
    description: z.object({ short_desc: igmText, long_desc: igmText, additional_desc: z.record(z.string(), z.unknown()).optional() }).loose().optional(),
    expected_response_time: z.object({ duration: z.string().max(30).optional() }).loose().optional(),
    expected_resolution_time: z.object({ duration: z.string().max(30).optional() }).loose().optional(),
  }).loose(),
});
export const issueStatusMessage = z.object({ issue_id: z.string().min(1).max(100) }).loose();

export const orderIdMessage = z.object({ order_id: z.string().min(1).max(100), cancellation_reason_id: z.string().max(20).optional() }).loose();

export type OrderItemInput = z.infer<typeof orderItem>;
export const itemCount = (i: OrderItemInput): number => i.quantity?.count ?? i.quantity?.selected?.count ?? 1;

// ---- ACK / NACK ----
export const ACK = { message: { ack: { status: "ACK" as const } } };

export const ERROR_CODES = {
  invalidSignature: { type: "CONTEXT-ERROR", code: "10001", message: "Invalid signature" },
  badRequest: { type: "JSON-SCHEMA-ERROR", code: "10000", message: "Bad or malformed request" },
  wrongDomain: { type: "CONTEXT-ERROR", code: "10002", message: "Unsupported domain or city" },
  notForUs: { type: "CONTEXT-ERROR", code: "10003", message: "bpp_id does not match this subscriber" },
  unavailable: { type: "POLICY-ERROR", code: "20000", message: "Temporarily unavailable" },
} as const;

export function nack(e: { type: string; code: string; message: string }, detail?: string) {
  return { message: { ack: { status: "NACK" as const } }, error: { type: e.type, code: e.code, message: detail ? `${e.message}: ${detail}` : e.message } };
}

export function cityAllowed(cfg: Pick<OndcConfig, "cityCodes">, city: string | undefined): boolean {
  return cfg.cityCodes.includes("*") || (!!city && (cfg.cityCodes.includes(city) || city === "*"));
}

/** Context for a callback: same transaction, swapped roles, our identity as BPP, fresh timestamp. */
export function callbackContext(cfg: OndcConfig, inbound: BecknContext, action: CallbackAction, opts: { messageId?: string; now?: Date; coreVersion?: string } = {}): BecknContext {
  return {
    ...inbound,
    action,
    core_version: opts.coreVersion ?? cfg.coreVersion,
    bpp_id: cfg.subscriberId,
    bpp_uri: cfg.subscriberUrl,
    message_id: opts.messageId ?? inbound.message_id,
    timestamp: (opts.now ?? new Date()).toISOString(),
    ttl: cfg.ttl,
  };
}

export const newMessageId = (): string => randomUUID();
