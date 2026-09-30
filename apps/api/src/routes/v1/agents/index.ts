// External agent REST API (ADR-020). Mount with `v1.route("/", agentRoutes);`. Third-party procurement agents act ONLY as the key's
// business, within the mandates its people created. There is no confirm endpoint: a deal needs the business's people (or auto-accept
// they enabled within bounds).
import { z } from "@hono/zod-openapi";
import { api, body, json, router } from "../../helpers";
import * as ops from "./ops";
import {
  Mandate, MandateListQuery, Negotiation, NegotiationListQuery, NegotiationMessageBody, NegotiationStart, NegotiationSummary,
  idempotencyHeader, optionalIdempotencyHeader, pageOf,
} from "./schemas";

export const agentRoutes = router();
const note = "Requires a key bound to a business. Part of the agent-to-agent API (ADR-020); needs A2A to be enabled for negotiations.";
const IdParam = z.object({ id: z.string().openapi({ format: "uuid" }) });
const tags = ["Agents"];

agentRoutes.openapi(
  api({
    scope: ops.AGENTS_READ,
    cfg: {
      method: "get", path: "/agents/mandates", operationId: "listAgentMandates", tags, summary: "List your agent mandates",
      description: `Mandates are created by your business's people in the app; the API cannot create them or enable auto-accept. ${note}`,
      request: { query: MandateListQuery },
      responses: { 200: json(pageOf("AgentMandatePage", Mandate), "Page of mandates") },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await ops.mandates(c.get("principal"), q) as never, 200);
  },
);

agentRoutes.openapi(
  api({
    scope: ops.AGENTS_READ, errors: [404],
    cfg: {
      method: "get", path: "/agents/mandates/{id}", operationId: "getAgentMandate", tags, summary: "Get a mandate",
      description: note, request: { params: IdParam }, responses: { 200: json(Mandate, "Mandate") },
    },
  }),
  async (c) => c.json((await ops.mandate(c.get("principal"), c.req.valid("param").id)) as never, 200),
);

agentRoutes.openapi(
  api({
    scope: ops.AGENTS_READ,
    cfg: {
      method: "get", path: "/agents/negotiations", operationId: "listAgentNegotiations", tags, summary: "List your negotiations",
      description: note, request: { query: NegotiationListQuery },
      responses: { 200: json(pageOf("AgentNegotiationPage", NegotiationSummary), "Page of negotiations, newest first") },
    },
  }),
  async (c) => c.json((await ops.negotiations(c.get("principal"), c.req.valid("query"))) as never, 200),
);

agentRoutes.openapi(
  api({
    scope: ops.AGENTS_READ, errors: [404],
    cfg: {
      method: "get", path: "/agents/negotiations/{id}", operationId: "getAgentNegotiation", tags, summary: "Get a negotiation",
      description: `The transcript as your business sees it. Your own limits are included; the counterparty's are never shown. ${note}`,
      request: { params: IdParam }, responses: { 200: json(Negotiation, "Negotiation with messages") },
    },
  }),
  async (c) => c.json((await ops.negotiation(c.get("principal"), c.req.valid("param").id)) as never, 200),
);

agentRoutes.openapi(
  api({
    scope: ops.AGENTS_WRITE, errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/agents/negotiations", operationId: "startAgentNegotiation", tags, summary: "Start a negotiation on a match",
      description: `Opens a negotiation on a match using one of your active mandates. Idempotent per match. Rate limited per business (A2A_STARTS_PER_HOUR). Returns 409 when A2A is not enabled. ${note}`,
      request: { headers: optionalIdempotencyHeader, body: body(NegotiationStart) },
      responses: { 201: json(Negotiation, "Negotiation") },
    },
  }),
  async (c) => {
    const key = c.req.valid("header")["idempotency-key"];
    return c.json((await ops.start(c.get("principal"), c.req.valid("json"), key)) as never, 201);
  },
);

agentRoutes.openapi(
  api({
    scope: ops.AGENTS_WRITE, errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/agents/negotiations/{id}/messages", operationId: "sendAgentNegotiationMessage", tags, summary: "Send an offer, counter, accept, reject or withdraw",
      description:
        `Bounds are enforced server-side; a violation names only your own limits. An accept leaves the negotiation "agreed": it is never a deal until your business's people confirm it in the app (there is no confirm endpoint), unless they enabled auto-accept within bounds. A buyer never lowers its own price and a seller never raises. Per-business and per-key message rate limits apply (429). Retrying with the same Idempotency-Key returns the original result. ${note}`,
      request: { params: IdParam, headers: idempotencyHeader, body: body(NegotiationMessageBody) },
      responses: { 201: json(Negotiation, "Updated negotiation") },
    },
  }),
  async (c) =>
    c.json((await ops.send(c.get("principal"), c.req.valid("param").id, c.req.valid("json") as never, c.req.valid("header")["idempotency-key"])) as never, 201),
);
