// Rate-contract REST API (docs/design/rate-contracts.md). Mount with `v1.route("/", contractRoutes);`. Read your contracts and place
// call-off orders at the locked contract prices. Creating, amending and accepting contracts needs the business's people in the app.
import { z } from "@hono/zod-openapi";
import { pageOf } from "../../../schemas";
import { api, body, json, router } from "../../helpers";
import * as ops from "./ops";
import { CallOffCreate, CallOffResult, Contract, ContractListQuery, ContractRow, idempotencyHeader } from "./schemas";

export const contractRoutes = router();
const note = "Requires a key bound to a business. Contracts are private between the two parties.";
const IdParam = z.object({ id: z.string().openapi({ format: "uuid" }) });
const tags = ["Rate contracts"];

contractRoutes.openapi(
  api({
    scope: "contracts:read",
    cfg: {
      method: "get", path: "/contracts", operationId: "listRateContracts", tags, summary: "List your rate contracts",
      description: `Contracts where your business is the buyer or the seller (choose with \`role\`). Sellers never see a buyer's unsent drafts. ${note}`,
      request: { query: ContractListQuery },
      responses: { 200: json(pageOf("RateContractPage", ContractRow), "Page of contracts, newest first") },
    },
  }),
  async (c) => c.json((await ops.list(c.get("principal"), c.req.valid("query"))) as never, 200),
);

contractRoutes.openapi(
  api({
    scope: "contracts:read", errors: [404],
    cfg: {
      method: "get", path: "/contracts/{id}", operationId: "getRateContract", tags, summary: "Get a rate contract",
      description: `The terms in force, any revision waiting for an answer, the revision history, consumption against the caps and every call-off. ${note}`,
      request: { params: IdParam },
      responses: { 200: json(Contract, "Rate contract") },
    },
  }),
  async (c) => c.json((await ops.get(c.get("principal"), c.req.valid("param").id)) as never, 200),
);

contractRoutes.openapi(
  api({
    scope: "contracts:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/contracts/{id}/call-offs", operationId: "placeRateContractCallOff", tags, summary: "Place a call-off order",
      description:
        "Buyer only. Creates an order (and, while purchase orders are enabled, a purchase order) at the contract's locked prices without an RFQ. " +
        "Fixed prices cannot be overridden; an `indexed` item may move within its declared cap. The minimum per call-off, each item's quantity cap and the contract value cap are enforced, " +
        `and the contract must be active and inside its dates. Crossing 80% or 100% of a cap notifies both parties. ${note}`,
      request: { params: IdParam, headers: idempotencyHeader, body: body(CallOffCreate) },
      responses: { 201: json(CallOffResult, "The call-off, its order and purchase order") },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    return c.json((await ops.callOff(c.get("principal"), c.req.valid("param").id, { ...input, idempotencyKey: key })) as never, 201);
  },
);
