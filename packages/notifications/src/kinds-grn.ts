// Goods receipt, return and credit-note kinds (docs/design/grn-returns.md). Same contract as kinds-payables.ts: each kind observes one domain
// event, resolves recipients per PERSON and carries default copy (English here, Hindi in `localized`; staff edit the live text in the template
// studio). All are TRANSACTIONAL ("messages" for the goods/returns conversation, "billing" for the credit note). Copy never names the counterparty.
import type { DomainEvent } from "@cnote/core";
import { inr, v } from "./kind-helpers";
import { mk, to } from "./kinds-payables";
import type { NotificationKind } from "./types";

const GRN = v("grnNumber", "Goods receipt number", "GRN/26-27/000004");
const RMA = v("returnNumber", "Return number", "RMA/26-27/000002");
const UNITS = v("units", "Number of units", "10");
const AMOUNT = v("amount", "Amount", "₹2,950");
const CN = v("creditNoteNumber", "Credit note number", "CN/26-27/12");

const sellerReturn = (id: string) => `/returns/${id}`;
const buyerReturn = (id: string) => `/buyer/returns/${id}`;

export const GRN_KINDS: NotificationKind[] = [
  mk({
    key: "grn.recorded", name: "Goods receipt recorded", description: "The buyer recorded a goods receipt against a purchase order; the seller sees accepted and rejected units.",
    category: "messages", app: "seller", event: "GoodsReceiptRecorded", variables: [GRN, v("accepted", "Accepted units", "90"), v("rejected", "Rejected units", "10")], cta: "Open the order",
    subject: "Goods received: {{grnNumber}}", body: "The buyer recorded goods receipt {{grnNumber}}: {{accepted}} units accepted, {{rejected}} rejected. Check your invoice against it.",
    hi: ["माल प्राप्त: {{grnNumber}}", "खरीदार ने माल प्राप्ति {{grnNumber}} दर्ज की: {{accepted}} इकाइयाँ स्वीकार, {{rejected}} अस्वीकार। अपने इनवॉइस को इससे मिलाएँ।"],
    resolve: async (e: DomainEvent<"GoodsReceiptRecorded">, dir) =>
      to(dir, "seller", e.payload.sellerBusinessId, e.payload.orderId, { grnNumber: e.payload.number, accepted: e.payload.acceptedUnits, rejected: e.payload.rejectedUnits }),
  }),
  mk({
    key: "return.requested", name: "Return requested", description: "A buyer asked to return goods; the seller approves or rejects the request.",
    category: "messages", app: "seller", event: "GoodsReturnRequested", variables: [RMA, UNITS], cta: "Review the return",
    subject: "Return {{returnNumber}} requested", body: "The buyer asked to return {{units}} units (return {{returnNumber}}). Approve or reject it so they know what to do.",
    hi: ["वापसी {{returnNumber}} का अनुरोध", "खरीदार ने {{units}} इकाइयाँ वापस करने का अनुरोध किया है (वापसी {{returnNumber}})। इसे स्वीकार या अस्वीकार करें ताकि वे अगला कदम जान सकें।"],
    resolve: async (e: DomainEvent<"GoodsReturnRequested">, dir) => to(dir, "seller", e.payload.sellerBusinessId, e.payload.orderId, { returnNumber: e.payload.number, units: e.payload.units }, sellerReturn(e.payload.goodsReturnId)),
  }),
  mk({
    key: "return.approved", name: "Return approved", description: "The seller approved the return; the buyer ships the goods back and records the tracking reference.",
    category: "messages", app: "web", event: "GoodsReturnDecided", variables: [RMA], cta: "Open the return",
    subject: "Return {{returnNumber}} approved", body: "The seller approved return {{returnNumber}}. Send the goods back and record the tracking number on the return.",
    hi: ["वापसी {{returnNumber}} स्वीकृत", "विक्रेता ने वापसी {{returnNumber}} स्वीकार कर ली है। माल वापस भेजें और वापसी पर ट्रैकिंग नंबर दर्ज करें।"],
    resolve: async (e: DomainEvent<"GoodsReturnDecided">, dir) => (e.payload.decision !== "approved" ? [] : to(dir, "buyer", e.payload.buyerBusinessId, e.payload.orderId, { returnNumber: e.payload.number }, buyerReturn(e.payload.goodsReturnId))),
  }),
  mk({
    key: "return.rejected", name: "Return rejected", description: "The seller rejected the return request with a reason; the buyer may open a dispute.",
    category: "messages", app: "web", event: "GoodsReturnDecided", variables: [RMA], cta: "Open the return",
    subject: "Return {{returnNumber}} rejected", body: "The seller rejected return {{returnNumber}}. Open it to read the reason; if you disagree you can open a dispute from there.",
    hi: ["वापसी {{returnNumber}} अस्वीकृत", "विक्रेता ने वापसी {{returnNumber}} अस्वीकार कर दी है। कारण पढ़ने के लिए इसे खोलें; असहमत हों तो वहीं से विवाद खोल सकते हैं।"],
    resolve: async (e: DomainEvent<"GoodsReturnDecided">, dir) => (e.payload.decision !== "rejected" ? [] : to(dir, "buyer", e.payload.buyerBusinessId, e.payload.orderId, { returnNumber: e.payload.number }, buyerReturn(e.payload.goodsReturnId))),
  }),
  mk({
    key: "return.shipped", name: "Return shipped", description: "The buyer shipped the returned goods and recorded the tracking reference.",
    category: "messages", app: "seller", event: "GoodsReturnShipped", variables: [RMA], cta: "Open the return",
    subject: "Return {{returnNumber}} is on its way", body: "The buyer shipped the goods for return {{returnNumber}}. When they arrive, confirm receipt and record your credit note.",
    hi: ["वापसी {{returnNumber}} रास्ते में है", "खरीदार ने वापसी {{returnNumber}} का माल भेज दिया है। पहुँचने पर प्राप्ति की पुष्टि करें और अपना क्रेडिट नोट दर्ज करें।"],
    resolve: async (e: DomainEvent<"GoodsReturnShipped">, dir) => to(dir, "seller", e.payload.sellerBusinessId, e.payload.orderId, { returnNumber: e.payload.number }, sellerReturn(e.payload.goodsReturnId)),
  }),
  mk({
    key: "return.credit_note", name: "Credit note recorded", description: "The seller recorded a credit note for a return; it reduces what the buyer owes on the invoice.",
    category: "billing", app: "web", event: "ReturnCreditNoteRecorded", variables: [RMA, CN, AMOUNT], cta: "Open the return",
    subject: "Credit note {{creditNoteNumber}}: {{amount}}", body: "The seller recorded credit note {{creditNoteNumber}} for {{amount}} against return {{returnNumber}}. It reduces what you owe on the invoice.",
    hi: ["क्रेडिट नोट {{creditNoteNumber}}: {{amount}}", "विक्रेता ने वापसी {{returnNumber}} के विरुद्ध {{amount}} का क्रेडिट नोट {{creditNoteNumber}} दर्ज किया है। इससे इनवॉइस पर आपकी देनदारी घटती है।"],
    resolve: async (e: DomainEvent<"ReturnCreditNoteRecorded">, dir) =>
      to(dir, "buyer", e.payload.buyerBusinessId, e.payload.orderId, { returnNumber: e.payload.returnNumber, creditNoteNumber: e.payload.creditNoteNumber, amount: inr(e.payload.totalPaise) }, buyerReturn(e.payload.goodsReturnId)),
  }),
];
