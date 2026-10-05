// @cnote/enquiry — RFQ/enquiry, intent-scored exclusive matching, messaging, quotes, deal reports (ADR-002, ADR-007).
// PUBLIC CONTRACT. Extend, don't break.
export type {
  EnquiryInput, Actor, MatchView, EnquiryView, LeadView, ConversationView, CreateEnquiryContext, SellerSummary, CandidateView,
} from "./types";
export { createEnquiry } from "./create";
export { listBuyerEnquiries, getBuyerEnquiry, listCandidatesForBuyer, pickSellers } from "./buyer";
export {
  listSellerLeads, getSellerLead, acceptLead, declineLead, reportBuyerProblem, resolveEnquiryReview, expireOverdueOffers,
} from "./leads";
export { listRefundReviews, resolveRefundReview, refundGuardConfig, type RefundReviewRow } from "./refund-guard";
export { getConversation, sendMessage, sendQuote, reportDeal } from "./messaging";
export { worker } from "./worker";

export * from "./getters";
export * from "./orders";
export * from "./retention";
export * from "./reachability";
export * from "./benchmarks";
export * from "./response-stats";
export * from "./quotes";
export * from "./fulfilment";
export * from "./attachments";
export * from "./comparison";
// rfq-multiline: BOM lines, per-line quotes, per-line awards (docs/design/rfq-multiline.md)
export * from "./lines";
export * from "./awards";

// DPDP access right: registered with @cnote/compliance's export registry (security audit M10).
export { exportPersonalData } from "./privacy";
export * from "./risk";
export { rfqEstimatePaise } from "./approvals";

// Purchase orders, supplier invoices, e-invoice / e-way bill references, MSME 43B(h) payment dues (docs/design/purchase-orders.md)
export * from "./po-core";
export * from "./purchase-orders";
export * from "./supplier-invoices";
export { getEInvoiceVerifier, setEInvoiceVerifier, mockEInvoiceVerifier, qrSvgDataUri, decodeSignedQr, type EInvoiceVerifier, type EInvoiceCheckInput, type EInvoiceCheckResult, type EInvoiceCheckStatus } from "./einvoice";
export { purgePurchaseOrderDocuments } from "./po-retention";

// Goods receipt notes, three-way match and returns (docs/design/grn-returns.md)
export * from "./grn-core";
export * from "./match-core";
export * from "./goods-receipts";
export * from "./match";
export * from "./returns";
export { purgeGoodsReceiptPhotos } from "./grn-retention";
