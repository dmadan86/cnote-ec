import * as ops from "../../ops";
import {
  Id, Sample, SampleAccept, SampleBulkLink, SampleBulkPrefill, SampleDecline, SampleDispatch, SampleEvaluate, SampleListQuery, SamplePayment, SampleRequestCreate,
  SampleSummary, SellerSampleStats, pageOf,
} from "../../schemas";
import { api, body, json, router } from "../helpers";

export const sampleRoutes = router();
const SamplePage = pageOf("SamplePage", SampleSummary);
const note =
  "Requires a key bound to a business. Sample payment is off-platform in Phase 1: the amount and whether it is adjustable against the bulk order are recorded only. Answers 404 while SAMPLES_ENABLED is off.";
const updated = json(Sample, "Updated sample request");

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples", operationId: "requestSample", tags: ["Samples"], summary: "Request a sample (buyer)",
      description: `From a product page (\`listingId\`, the seller must offer samples) or a matched conversation (\`conversationId\`, optionally \`quoteId\`). The seller must answer within 48 hours or the request expires. Guards: quantity cap, the seller's minimum buyer verification tier, open requests per buyer and a daily limit. ${note}`,
      request: { body: body(SampleRequestCreate) },
      responses: { 201: json(Sample, "Created request") },
    },
  }),
  async (c) => c.json(await ops.requestSampleOp(c.get("principal"), c.req.valid("json")), 201),
);

sampleRoutes.openapi(
  api({
    scope: "samples:read",
    cfg: {
      method: "get", path: "/samples", operationId: "listSamples", tags: ["Samples"], summary: "List sample requests",
      description: `\`role=buyer\` lists requests you made, \`role=seller\` the ones sent to your business (the sample inbox). ${note}`,
      request: { query: SampleListQuery },
      responses: { 200: json(SamplePage, "Page of sample requests") },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await ops.listSamplesOp(c.get("principal"), q.role, q.filter, q.cursor, q.limit), 200);
  },
);

sampleRoutes.openapi(
  api({
    scope: "samples:read", errors: [404],
    cfg: {
      method: "get", path: "/samples/{id}", operationId: "getSample", tags: ["Samples"], summary: "Get a sample request",
      description: `Status, timeline, what you can do next (\`can\`) and, for the seller, the ship-to address once accepted. ${note}`,
      request: { params: Id },
      responses: { 200: json(Sample, "Sample request") },
    },
  }),
  async (c) => c.json(await ops.getSampleOp(c.get("principal"), c.req.valid("param").id), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409],
    cfg: {
      method: "post", path: "/samples/{id}/cancel", operationId: "cancelSample", tags: ["Samples"], summary: "Cancel a request (buyer)",
      description: `Possible while the request is \`requested\` or \`accepted\`. ${note}`,
      request: { params: Id }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "cancel", c.req.valid("param").id), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples/{id}/accept", operationId: "acceptSample", tags: ["Samples"], summary: "Accept a request (seller)",
      description: `Reveals the ship-to address to you. Set the amount the buyer pays and whether it is adjustable against the bulk order. ${note}`,
      request: { params: Id, body: body(SampleAccept) }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "accept", c.req.valid("param").id, c.req.valid("json")), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples/{id}/decline", operationId: "declineSample", tags: ["Samples"], summary: "Decline a request (seller)",
      description: `Needs a structured reason. ${note}`,
      request: { params: Id, body: body(SampleDecline) }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "decline", c.req.valid("param").id, c.req.valid("json")), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples/{id}/dispatch", operationId: "dispatchSample", tags: ["Samples"], summary: "Mark a sample dispatched (seller)",
      description: `Courier is required, the tracking reference optional. ${note}`,
      request: { params: Id, body: body(SampleDispatch) }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "dispatch", c.req.valid("param").id, c.req.valid("json")), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409],
    cfg: {
      method: "post", path: "/samples/{id}/delivered", operationId: "markSampleDelivered", tags: ["Samples"], summary: "Mark a sample delivered (buyer or seller)",
      description: `The buyer's confirmation is the normal path. ${note}`,
      request: { params: Id }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "delivered", c.req.valid("param").id), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples/{id}/payment", operationId: "recordSamplePayment", tags: ["Samples"], summary: "Record that the sample payment arrived (seller)",
      description: `Record only; nothing is charged by the platform. ${note}`,
      request: { params: Id, body: body(SamplePayment) }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "payment", c.req.valid("param").id, c.req.valid("json")), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples/{id}/evaluate", operationId: "evaluateSample", tags: ["Samples"], summary: "Evaluate a delivered sample (buyer)",
      description: `Approve it, or reject with at least one structured reason. An approved sample becomes the golden quality reference for the bulk order. Photos are uploaded from the web app. ${note}`,
      request: { params: Id, body: body(SampleEvaluate) }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "evaluate", c.req.valid("param").id, c.req.valid("json")), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409],
    cfg: {
      method: "post", path: "/samples/{id}/accept-quote", operationId: "acceptSampleQuote", tags: ["Samples"], summary: "Accept the linked quote (buyer)",
      description: `For a sample requested against a seller's quote: accepts that quote (recording the deal and creating the order) with the approved sample as the quality reference. ${note}`,
      request: { params: Id }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "acceptQuote", c.req.valid("param").id), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/samples/{id}/bulk-enquiry", operationId: "linkSampleBulkEnquiry", tags: ["Samples"], summary: "Link a bulk RFQ to an approved sample (buyer)",
      description: `Call after creating the RFQ from \`GET /samples/{id}/bulk-prefill\`; the supplier then sees it refers to an approved sample. ${note}`,
      request: { params: Id, body: body(SampleBulkLink) }, responses: { 200: updated },
    },
  }),
  async (c) => c.json(await ops.sampleAction(c.get("principal"), "link", c.req.valid("param").id, c.req.valid("json")), 200),
);

sampleRoutes.openapi(
  api({
    scope: "samples:read", errors: [404, 409],
    cfg: {
      method: "get", path: "/samples/{id}/bulk-prefill", operationId: "getSampleBulkPrefill", tags: ["Samples"], summary: "RFQ pre-fill from an approved sample (buyer)",
      description: `What to put in the bulk RFQ: subject, category, supplier and a requirement note that names the approved sample as the quality reference. ${note}`,
      request: { params: Id },
      responses: { 200: json(SampleBulkPrefill, "Pre-fill") },
    },
  }),
  async (c) => c.json(await ops.sampleBulkPrefillOp(c.get("principal"), c.req.valid("param").id), 200),
);

sampleRoutes.openapi(
  api({
    scope: "catalogue:read", errors: [404],
    cfg: {
      method: "get", path: "/sellers/{id}/sample-stats", operationId: "getSellerSampleStats", tags: ["Samples"], summary: "A seller's sample track record",
      description: "Evaluated and approved sample counts. `approvalRate` is null until 5 samples were evaluated. Answers 404 while SAMPLES_ENABLED is off.",
      request: { params: Id },
      responses: { 200: json(SellerSampleStats, "Stats") },
    },
  }),
  async (c) => c.json(await ops.sellerSampleStatsOp(c.req.valid("param").id), 200),
);
