// Purchase-order and supplier-invoice kinds, including the MSME 43B(h) payment reminders (docs/design/purchase-orders.md).
// Same contract as kinds.ts: each kind observes one domain event, resolves recipients per PERSON and carries default copy
// (English here, Hindi in `localized`; staff edit the live text in the template studio). All are TRANSACTIONAL
// ("messages" for the PO conversation, "billing" for money), so per-category preferences apply and none needs marketing consent.
// Copy never names the counterparty (ADR-010) and stays language-neutral: amounts, dates and numbers come from the event.
import type { DomainEvent, DomainEventType } from "@cnote/core";
import { fan, HREF, inr, kind, membersOf, RECIPIENT_NAME, v } from "./kind-helpers";
import type { NotificationApp, NotificationCategory, NotificationKind, Recipient } from "./types";
import type { Directory } from "./recipients";

export type Side = "buyer" | "seller";
const APP: Record<Side, NotificationApp> = { buyer: "web", seller: "seller" };
const poHref = (side: Side, orderId: string) => (side === "buyer" ? `/buyer/orders/${orderId}/purchase-order` : `/orders/${orderId}/purchase-order`);

/** "2026-10-31" -> "31 Oct 2026" (Indian calendar date; no time zone shift). */
export function niceDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export interface Spec<E extends DomainEventType> {
  key: string;
  name: string;
  description: string;
  category: NotificationCategory;
  app: NotificationApp;
  event: E;
  variables: ReturnType<typeof v>[];
  subject: string;
  body: string;
  hi: readonly [subject: string, body: string];
  cta: string;
  resolve: NotificationKind<E>["resolve"];
}

export function mk<E extends DomainEventType>(s: Spec<E>): NotificationKind {
  const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}\n\n${cta}: {{href}}`;
  return kind<E>({
    key: s.key,
    name: s.name,
    description: s.description,
    category: s.category,
    app: s.app,
    event: s.event,
    variables: [...s.variables, RECIPIENT_NAME, HREF],
    defaults: { in_app: { subject: s.subject, body: s.body }, email: { subject: s.subject, body: email("Hi", s.body, s.cta) } },
    localized: { hi: { in_app: { subject: s.hi[0], body: s.hi[1] }, email: { subject: s.hi[0], body: email("नमस्ते", s.hi[1], "खोलें") } } },
    resolve: s.resolve,
  });
}

const PO = v("poNumber", "Purchase order number", "PO/26-27/000012");
const AMOUNT = v("amount", "Amount", "₹29,500");
const INVOICE = v("invoiceNumber", "Supplier invoice number", "INV/26-27/001");
const DUE = v("dueDate", "Payment due date", "31 Oct 2026");

export async function to(dir: Directory, side: Side, businessId: string, orderId: string, vars: Record<string, unknown>, href = poHref(side, orderId)): Promise<Recipient[]> {
  return fan(await membersOf(dir, businessId), { businessId, app: APP[side], vars, href });
}

export const PAYABLE_KINDS: NotificationKind[] = [
  mk({
    key: "po.issued", name: "Purchase order received", description: "A buyer issued a purchase order for an order; the seller can accept or reject it.",
    category: "messages", app: "seller", event: "PurchaseOrderIssued", variables: [PO, AMOUNT], cta: "Open the purchase order",
    subject: "Purchase order {{poNumber}} received", body: "You received purchase order {{poNumber}} for {{amount}}. Review it and accept or reject it.",
    hi: ["क्रय आदेश {{poNumber}} मिला", "आपको {{amount}} का क्रय आदेश {{poNumber}} मिला है। इसे देखें और स्वीकार या अस्वीकार करें।"],
    resolve: async (e: DomainEvent<"PurchaseOrderIssued">, dir) => to(dir, "seller", e.payload.sellerBusinessId, e.payload.orderId, { poNumber: e.payload.number, amount: inr(e.payload.totalPaise) }),
  }),
  mk({
    key: "po.amended", name: "Purchase order amended", description: "The buyer issued a new version of a purchase order; the seller must answer again.",
    category: "messages", app: "seller", event: "PurchaseOrderAmended", variables: [PO, v("version", "New version number", "2"), AMOUNT], cta: "Open the purchase order",
    subject: "Purchase order {{poNumber}} amended (version {{version}})", body: "Purchase order {{poNumber}} has a new version {{version}} for {{amount}}. Please accept or reject it again.",
    hi: ["क्रय आदेश {{poNumber}} संशोधित (संस्करण {{version}})", "क्रय आदेश {{poNumber}} का नया संस्करण {{version}} ({{amount}}) आया है। कृपया इसे फिर से स्वीकार या अस्वीकार करें।"],
    resolve: async (e: DomainEvent<"PurchaseOrderAmended">, dir) => to(dir, "seller", e.payload.sellerBusinessId, e.payload.orderId, { poNumber: e.payload.number, version: e.payload.version, amount: inr(e.payload.totalPaise) }),
  }),
  mk({
    key: "po.accepted", name: "Purchase order accepted", description: "The seller accepted the purchase order (the written agreement on payment terms).",
    category: "messages", app: "web", event: "PurchaseOrderAcknowledged", variables: [PO], cta: "Open the purchase order",
    subject: "Purchase order {{poNumber}} accepted", body: "The seller accepted purchase order {{poNumber}}. Its payment terms are now the written agreement for this order.",
    hi: ["क्रय आदेश {{poNumber}} स्वीकार हुआ", "विक्रेता ने क्रय आदेश {{poNumber}} स्वीकार कर लिया। इसकी भुगतान शर्तें अब इस ऑर्डर का लिखित समझौता हैं।"],
    resolve: async (e: DomainEvent<"PurchaseOrderAcknowledged">, dir) => (e.payload.decision !== "accepted" ? [] : to(dir, "buyer", e.payload.buyerBusinessId, e.payload.orderId, { poNumber: e.payload.number })),
  }),
  mk({
    key: "po.rejected", name: "Purchase order rejected", description: "The seller rejected the purchase order with a reason; the buyer can amend it.",
    category: "messages", app: "web", event: "PurchaseOrderAcknowledged", variables: [PO, v("reason", "The seller's reason", "Price too low")], cta: "Open the purchase order",
    subject: "Purchase order {{poNumber}} rejected", body: "The seller rejected purchase order {{poNumber}}. Reason: {{reason}}. You can amend it and send a new version.",
    hi: ["क्रय आदेश {{poNumber}} अस्वीकृत", "विक्रेता ने क्रय आदेश {{poNumber}} अस्वीकार कर दिया। कारण: {{reason}}। आप इसमें बदलाव करके नया संस्करण भेज सकते हैं।"],
    resolve: async (e: DomainEvent<"PurchaseOrderAcknowledged">, dir) => {
      if (e.payload.decision !== "rejected") return [];
      const reason = (e.payload.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given";
      return to(dir, "buyer", e.payload.buyerBusinessId, e.payload.orderId, { poNumber: e.payload.number, reason });
    },
  }),
  mk({
    key: "po.cancelled", name: "Purchase order cancelled", description: "A purchase order was cancelled; the other party is told.",
    category: "messages", app: "web", event: "PurchaseOrderCancelled", variables: [PO], cta: "Open the order",
    subject: "Purchase order {{poNumber}} cancelled", body: "Purchase order {{poNumber}} was cancelled. Open the order to see why.",
    hi: ["क्रय आदेश {{poNumber}} रद्द", "क्रय आदेश {{poNumber}} रद्द कर दिया गया है। कारण देखने के लिए ऑर्डर खोलें।"],
    resolve: async (e: DomainEvent<"PurchaseOrderCancelled">, dir) => {
      const p = e.payload;
      const side: Side = p.cancelledByBusinessId === p.buyerBusinessId ? "seller" : "buyer";
      return to(dir, side, side === "seller" ? p.sellerBusinessId : p.buyerBusinessId, p.orderId, { poNumber: p.number });
    },
  }),
  mk({
    key: "invoice.recorded", name: "Supplier invoice recorded", description: "The seller recorded a tax invoice against a purchase order; the buyer sees the pay-by date.",
    category: "billing", app: "web", event: "SupplierInvoiceRecorded", variables: [INVOICE, AMOUNT, DUE], cta: "See what to pay",
    subject: "Invoice {{invoiceNumber}} recorded: pay by {{dueDate}}", body: "Invoice {{invoiceNumber}} for {{amount}} was recorded against your purchase order. Pay by {{dueDate}}.",
    hi: ["इनवॉइस {{invoiceNumber}} दर्ज: {{dueDate}} तक भुगतान करें", "आपके क्रय आदेश के विरुद्ध {{amount}} का इनवॉइस {{invoiceNumber}} दर्ज हुआ है। {{dueDate}} तक भुगतान करें।"],
    resolve: async (e: DomainEvent<"SupplierInvoiceRecorded">, dir) => {
      const p = e.payload;
      if (!p.dueDate) return [];
      return to(dir, "buyer", p.buyerBusinessId, p.orderId, { invoiceNumber: p.invoiceNumber, amount: inr(p.totalPaise), dueDate: niceDate(p.dueDate) }, "/buyer/payables");
    },
  }),
  mk({
    key: "invoice.payment_recorded", name: "Buyer recorded a payment", description: "The buyer recorded a payment against the seller's invoice.",
    category: "billing", app: "seller", event: "SupplierInvoicePaymentRecorded", variables: [AMOUNT], cta: "Open the order",
    subject: "Payment of {{amount}} recorded", body: "The buyer recorded a payment of {{amount}} against one of your invoices. Check it against your bank statement.",
    hi: ["{{amount}} का भुगतान दर्ज", "खरीदार ने आपके एक इनवॉइस के विरुद्ध {{amount}} का भुगतान दर्ज किया है। इसे अपने बैंक स्टेटमेंट से मिलाएँ।"],
    resolve: async (e: DomainEvent<"SupplierInvoicePaymentRecorded">, dir) => to(dir, "seller", e.payload.sellerBusinessId, e.payload.orderId, { amount: inr(e.payload.amountPaise) }),
  }),
  mk({
    key: "payable.due_t7", name: "MSME payment due in a week", description: "An invoice from a micro or small enterprise is due within 7 days (IT Act s.43B(h)).",
    category: "billing", app: "web", event: "SupplierInvoiceDueReminder", variables: [INVOICE, AMOUNT, DUE], cta: "See your payables",
    subject: "Pay invoice {{invoiceNumber}} by {{dueDate}}", body: "{{amount}} is due on {{dueDate}} for invoice {{invoiceNumber}} from a micro or small enterprise. Paying after the due date can make the expense non-deductible this year (section 43B(h)).",
    hi: ["इनवॉइस {{invoiceNumber}} का भुगतान {{dueDate}} तक करें", "सूक्ष्म या लघु उद्यम के इनवॉइस {{invoiceNumber}} के {{amount}} देय तिथि {{dueDate}} तक चुकाने हैं। देय तिथि के बाद भुगतान से यह खर्च इस वर्ष कटौती योग्य नहीं रह सकता (धारा 43बी(ज))।"],
    resolve: async (e: DomainEvent<"SupplierInvoiceDueReminder">, dir) => reminder(e, dir, "t7"),
  }),
  mk({
    key: "payable.due_t1", name: "MSME payment due tomorrow", description: "An invoice from a micro or small enterprise is due tomorrow or today (IT Act s.43B(h)).",
    category: "billing", app: "web", event: "SupplierInvoiceDueReminder", variables: [INVOICE, AMOUNT, DUE], cta: "See your payables",
    subject: "Invoice {{invoiceNumber}} is due {{dueDate}}", body: "{{amount}} for invoice {{invoiceNumber}} from a micro or small enterprise is due {{dueDate}}. Pay in time and mark it paid with the UTR.",
    hi: ["इनवॉइस {{invoiceNumber}} की देय तिथि {{dueDate}}", "सूक्ष्म या लघु उद्यम के इनवॉइस {{invoiceNumber}} के {{amount}} की देय तिथि {{dueDate}} है। समय पर भुगतान करें और UTR के साथ भुगतान दर्ज करें।"],
    resolve: async (e: DomainEvent<"SupplierInvoiceDueReminder">, dir) => reminder(e, dir, "t1"),
  }),
  mk({
    key: "payable.overdue", name: "MSME payment overdue", description: "An invoice from a micro or small enterprise is past its statutory due date (IT Act s.43B(h), MSMED Act s.15).",
    category: "billing", app: "web", event: "SupplierInvoiceDueReminder", variables: [INVOICE, AMOUNT, DUE, v("daysOverdue", "Days past the due date", "3")], cta: "See your payables",
    subject: "Invoice {{invoiceNumber}} is overdue", body: "{{amount}} for invoice {{invoiceNumber}} was due on {{dueDate}} ({{daysOverdue}} days ago). Payment after the statutory limit can make the expense non-deductible until it is paid (section 43B(h)) and may attract interest under the MSMED Act.",
    hi: ["इनवॉइस {{invoiceNumber}} का भुगतान बकाया है", "इनवॉइस {{invoiceNumber}} के {{amount}} की देय तिथि {{dueDate}} थी ({{daysOverdue}} दिन पहले)। वैधानिक सीमा के बाद भुगतान से खर्च भुगतान होने तक कटौती योग्य नहीं रहता (धारा 43बी(ज)) और MSMED अधिनियम के तहत ब्याज लग सकता है।"],
    resolve: async (e: DomainEvent<"SupplierInvoiceDueReminder">, dir) => reminder(e, dir, "overdue"),
  }),
];

async function reminder(e: DomainEvent<"SupplierInvoiceDueReminder">, dir: Directory, stage: "t7" | "t1" | "overdue"): Promise<Recipient[]> {
  const p = e.payload;
  if (p.stage !== stage) return [];
  return to(dir, "buyer", p.buyerBusinessId, p.orderId, { invoiceNumber: p.invoiceNumber, amount: inr(p.outstandingPaise), dueDate: niceDate(p.dueDate), daysOverdue: p.daysOverdue }, "/buyer/payables");
}
