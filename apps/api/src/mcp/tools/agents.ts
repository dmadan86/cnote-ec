// MCP tools for external agents (ADR-020). Same operations as /v1/agents; the key must be bound to a business.
import { z } from "zod";
import * as ops from "../../routes/v1/agents/ops";
import type { ToolDef } from "../tools";

const tool = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;
const read = { readOnlyHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const id = (what: string) => z.string().describe(`${what} (UUID)`);
const idem = z.string().min(1).max(100).describe("REQUIRED. Unique per message you intend to send; retrying with the same key returns the original result and never sends twice.");
const page = { cursor: z.string().optional().describe("nextCursor from the previous page"), limit: z.number().int().min(1).max(100).default(25) };

const RULES =
  " Never invent terms: use only values your principal gave you or the mandate allows. The human principal, not you, confirms deals (an accept leaves the negotiation 'agreed' until the business's people confirm). You cannot see the other side's limits; violations only name your own.";

const termsShape = {
  negotiationId: id("Negotiation id"),
  idempotencyKey: idem,
  pricePaise: z.number().int().positive().describe("Unit price in integer paise (INR x 100)"),
  quantity: z.number().int().positive(),
  unit: z.string().min(1).max(20),
  leadTimeDays: z.number().int().min(0).max(365),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Last day the offer can be accepted, YYYY-MM-DD (at most 90 days ahead)"),
  deliveryTerms: z.string().max(300).optional(),
  paymentTerms: z.string().max(200).optional(),
};
const noTerms = { negotiationId: id("Negotiation id"), idempotencyKey: idem };

export const AGENT_TOOLS: ToolDef[] = [
  tool({
    name: "list_agent_mandates", scope: ops.AGENTS_READ, title: "List agent mandates", annotations: read,
    description: "List the agent mandates of the key's business (created by its people in the app; you cannot create or change them)." + RULES,
    input: { side: z.enum(["buyer", "seller"]).optional(), ...page },
    run: (p, a) => ops.mandates(p, a),
  }),
  tool({
    name: "get_agent_mandate", scope: ops.AGENTS_READ, title: "Get agent mandate", annotations: read,
    description: "Get one mandate of the key's business, including its own limits." + RULES,
    input: { mandateId: id("Mandate id") },
    run: (p, a) => ops.mandate(p, a.mandateId),
  }),
  tool({
    name: "list_agent_negotiations", scope: ops.AGENTS_READ, title: "List agent negotiations", annotations: read,
    description: "List the key business's negotiations, newest first." + RULES,
    input: { status: z.enum(["open", "agreed", "accepted", "rejected", "withdrawn", "expired"]).optional(), side: z.enum(["buyer", "seller"]).optional(), ...page },
    run: (p, a) => ops.negotiations(p, a),
  }),
  tool({
    name: "get_agent_negotiation", scope: ops.AGENTS_READ, title: "Get agent negotiation", annotations: read,
    description: "Get a negotiation with its transcript as your business sees it (yours limits only, never the counterparty's)." + RULES,
    input: { negotiationId: id("Negotiation id") },
    run: (p, a) => ops.negotiation(p, a.negotiationId),
  }),
  tool({
    name: "start_agent_negotiation", scope: ops.AGENTS_WRITE, title: "Start agent negotiation", annotations: write,
    description: "Start a negotiation on a match with one of your active mandates. Idempotent per match; pass idempotencyKey to make retries safe." + RULES,
    input: { mandateId: id("Mandate id"), matchId: id("Match id"), idempotencyKey: z.string().min(1).max(100).optional() },
    run: (p, a) => ops.start(p, { mandateId: a.mandateId, matchId: a.matchId }, a.idempotencyKey),
  }),
  tool({
    name: "send_agent_offer", scope: ops.AGENTS_WRITE, title: "Send offer or counter", annotations: write,
    description:
      "Send an opening offer (type 'offer', only when there is no standing offer) or a counter (type 'counter', against the other side's standing offer). Must be within your own bounds; a buyer never lowers its own price, a seller never raises." + RULES,
    input: { type: z.enum(["offer", "counter"]), ...termsShape },
    run: (p, a) => {
      const { type, negotiationId, idempotencyKey, ...offer } = a;
      return ops.send(p, negotiationId, { type, offer }, idempotencyKey);
    },
  }),
  tool({
    name: "accept_agent_offer", scope: ops.AGENTS_WRITE, title: "Accept standing offer", annotations: write,
    description: "Accept the other side's standing offer. The negotiation becomes 'agreed' but is NOT a deal until your business's people confirm it." + RULES,
    input: noTerms,
    run: (p, a) => ops.send(p, a.negotiationId, { type: "accept" }, a.idempotencyKey),
  }),
  tool({
    name: "reject_agent_offer", scope: ops.AGENTS_WRITE, title: "Reject standing offer", annotations: { ...write, destructiveHint: true },
    description: "Reject the other side's standing offer, closing the negotiation." + RULES,
    input: noTerms,
    run: (p, a) => ops.send(p, a.negotiationId, { type: "reject" }, a.idempotencyKey),
  }),
  tool({
    name: "withdraw_agent_negotiation", scope: ops.AGENTS_WRITE, title: "Withdraw from negotiation", annotations: { ...write, destructiveHint: true },
    description: "Withdraw from an open negotiation." + RULES,
    input: noTerms,
    run: (p, a) => ops.send(p, a.negotiationId, { type: "withdraw" }, a.idempotencyKey),
  }),
];
