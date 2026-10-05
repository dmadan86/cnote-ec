import { clientIp } from "@cnote/security/client-ip";
import { z } from "@hono/zod-openapi";
import * as ops from "../../ops";
import {
  AwardedLine, Conversation, DealReportCreate, Enquiry, EnquiryCreate, Id, LineAwardCreate, LineAwardResult, MessageCreate, Ok, QuoteCreate, pageOf, pageQuery,
} from "../../schemas";
import { api, body, json, router } from "../helpers";

export const buyerRoutes = router();
const EnquiryPage = pageOf("EnquiryPage", Enquiry);
const buyerNote = "Requires a key bound to a business.";

buyerRoutes.openapi(
  api({
    scope: "enquiries:write", errors: [422],
    cfg: {
      method: "post", path: "/enquiries", operationId: "createEnquiry", tags: ["Enquiries"], summary: "Post an enquiry (RFQ)",
      description:
        `The enquiry is intent-scored by AI and, if it passes, matched exclusively to at most N sellers ranked by relevance and trust (ADR-002); low-intent or prohibited enquiries are held for review or rejected. Matching is synchronous, so the response already lists the matches. ${buyerNote}`,
      request: { body: body(EnquiryCreate) },
      responses: { 201: json(Enquiry, "Created enquiry with its matches") },
    },
  }),
  async (c) => c.json(await ops.newEnquiry(c.get("principal"), c.req.valid("json"), clientIp(c.req.raw.headers), c.req.header("user-agent")), 201),
);

buyerRoutes.openapi(
  api({
    scope: "enquiries:read",
    cfg: {
      method: "get", path: "/enquiries", operationId: "listEnquiries", tags: ["Enquiries"], summary: "List your enquiries",
      description: buyerNote,
      request: { query: z.object(pageQuery) },
      responses: { 200: json(EnquiryPage, "Page of enquiries") },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await ops.myEnquiries(c.get("principal"), q.cursor, q.limit), 200);
  },
);

buyerRoutes.openapi(
  api({
    scope: "enquiries:read", errors: [404],
    cfg: {
      method: "get", path: "/enquiries/{id}", operationId: "getEnquiry", tags: ["Enquiries"], summary: "Get an enquiry",
      description: buyerNote,
      request: { params: Id },
      responses: { 200: json(Enquiry, "Enquiry") },
    },
  }),
  async (c) => c.json(await ops.enquiry(c.get("principal"), c.req.valid("param").id), 200),
);

buyerRoutes.openapi(
  api({
    scope: "enquiries:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/enquiries/{id}/awards", operationId: "awardEnquiryLines", tags: ["Enquiries"], summary: "Award requirement lines to supplier quotes",
      description:
        `Per-line award for a multi-line RFQ: give different lines to different suppliers' latest quotes. Each supplier gets one off-platform order covering only its lines, valued at the server-computed line totals. A line can be awarded once, and a supplier that already has an order on this enquiry takes no more lines. ${buyerNote}`,
      request: { params: Id, body: body(LineAwardCreate) },
      responses: { 201: json(LineAwardResult, "One order per awarded supplier") },
    },
  }),
  async (c) => c.json(await ops.awardEnquiryLines(c.get("principal"), c.req.valid("param").id, c.req.valid("json").awards), 201),
);

buyerRoutes.openapi(
  api({
    scope: "enquiries:read", errors: [404],
    cfg: {
      method: "get", path: "/enquiries/{id}/awards", operationId: "listEnquiryAwards", tags: ["Enquiries"], summary: "List awarded lines",
      description: `Immutable snapshots of the lines awarded so far (item, spec, quantity, unit price, GST, supplier, order). ${buyerNote}`,
      request: { params: Id },
      responses: { 200: json(z.object({ items: z.array(AwardedLine) }).openapi("AwardedLinePage"), "Awarded lines, ordered by line number") },
    },
  }),
  async (c) => c.json(await ops.awardedLines(c.get("principal"), c.req.valid("param").id), 200),
);

buyerRoutes.openapi(
  api({
    scope: "messages:read", errors: [404],
    cfg: {
      method: "get", path: "/conversations/{id}", operationId: "getConversation", tags: ["Conversations"], summary: "Get a conversation",
      description: `Messages and quotes exchanged after a lead was accepted. Only the buyer and seller business can read it. ${buyerNote}`,
      request: { params: Id },
      responses: { 200: json(Conversation, "Conversation") },
    },
  }),
  async (c) => c.json(await ops.conversation(c.get("principal"), c.req.valid("param").id), 200),
);

buyerRoutes.openapi(
  api({
    scope: "messages:write", errors: [404, 422],
    cfg: {
      method: "post", path: "/conversations/{id}/messages", operationId: "sendMessage", tags: ["Conversations"], summary: "Send a message",
      description: `Rate limited per person (30/min). ${buyerNote}`,
      request: { params: Id, body: body(MessageCreate) },
      responses: { 201: json(Ok, "Sent") },
    },
  }),
  async (c) => c.json(await ops.message(c.get("principal"), c.req.valid("param").id, c.req.valid("json").body), 201),
);

buyerRoutes.openapi(
  api({
    scope: "messages:write", errors: [404, 422],
    cfg: {
      method: "post", path: "/conversations/{id}/quotes", operationId: "sendQuote", tags: ["Conversations"], summary: "Send a quote (seller only)",
      description: `Only the seller side of the conversation may quote; the buyer gets 403. Price is unit price in paise. ${buyerNote}`,
      request: { params: Id, body: body(QuoteCreate) },
      responses: { 201: json(Ok, "Quote sent") },
    },
  }),
  async (c) => c.json(await ops.quote(c.get("principal"), c.req.valid("param").id, c.req.valid("json")), 201),
);

buyerRoutes.openapi(
  api({
    scope: "messages:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/matches/{matchId}/deal-report", operationId: "reportDeal", tags: ["Conversations"], summary: "Report the deal outcome",
      description: `Deals close off-platform in Phase 1; either party reports whether it closed (ADR-007). Only a buyer-reported win records the deal and creates the order; a seller-reported win is advisory (the buyer is asked to confirm). Only accepted leads can be reported. ${buyerNote}`,
      request: { params: z.object({ matchId: z.string().openapi({ format: "uuid" }) }), body: body(DealReportCreate) },
      responses: { 201: json(Ok, "Recorded") },
    },
  }),
  async (c) => {
    const { outcome, valuePaise } = c.req.valid("json");
    return c.json(await ops.dealReport(c.get("principal"), c.req.valid("param").matchId, outcome, valuePaise), 201);
  },
);
