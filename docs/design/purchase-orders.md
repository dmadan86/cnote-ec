# Purchase orders, supplier invoices, e-invoice references and MSME payment dues

Status: built, on by default (`PURCHASE_ORDERS_ENABLED`). Owner: `@cnote/enquiry` (orders sub-module). Phase 1 settles off-platform (ADR-007): these are commercial documents and records, no money moves through the platform.

## What it does

1. **Purchase order (PO).** The buyer issues a PO for an order. Gap-free number per buyer business and Indian financial year (`PO/26-27/000012`), snapshot of both parties, the delivery address, payment terms in days, expected delivery date and line items (HSN if known, quantity, unit, unit price, GST rate, taxable value, tax, total). An immutable PDF is stored in the private media bucket. The seller accepts or rejects (with a reason). An amendment creates a new version; a sent version is never edited. The buyer can cancel until the seller records an invoice. Cancelling the order cancels the PO and withdraws unpaid invoices.
2. **Supplier invoice.** The seller records their own GST tax invoice against the PO (number, date, taxable value, GST, optional PDF/JPG/PNG copy). PO value, invoiced and outstanding amounts are shown to both sides. The platform does not issue these invoices.
3. **E-invoice / e-way bill references.** Optional IRN (64 hex), acknowledgement number and date, signed QR text (rendered as a QR image on the detail pages) and e-way bill number (12 digits) with validity. Record-only.
4. **MSME payment due date (Income Tax Act s.43B(h)).** For a covered seller the statutory due date is stored on the invoice, shown to the buyer as a "Pay by" badge with days left, and a scheduled job reminds the buyer at T-7, T-1 and when overdue. The buyer records payments (date, UTR). Admin has a read-only overdue view.

## Decisions

- **The PO is issued by the buyer, not auto-created on confirmation.** A PO needs a delivery address, payment terms and (for GST) a rate, which only the buyer knows. The order page shows "Issue purchase order" prominently; the form is prefilled from the order and its quote (quantity, unit, price, GST-included flag, payment terms `net_N` -> N days, lead time -> expected delivery).
- **One PO per order, versions inside it.** `PurchaseOrder` is the stable header; `PurchaseOrderVersion` rows are never edited after insert. The only write a version receives is its `pdfKey`/`pdfSha256`, set once right after the PDF is stored (guarded by `pdfKey IS NULL`). The one other sanctioned edit is the DPDP retention purge (below). Database triggers were not added: the app never updates versions, and retention needs to blank personal fields; the stored sha256 gives tamper evidence for the PDF.
- **Seller answers are append-only** (`purchase_order_acks`, latest row per version). Amending resets the status to `issued`; the seller must answer the new version.
- **Line based.** `PurchaseOrderLine` holds N lines; today the order's single quote line becomes line 1. `issuePurchaseOrder` already accepts `lines: PoLineInput[]`, so the multi-line RFQ work can pass them without a schema change. The amend form keeps the previous lines and edits terms only; editing lines in the UI arrives with multi-line RFQs.
- **GST.** Rate is a buyer input (default `PO_DEFAULT_GST_RATE_BPS`, 18%), never inferred from a category. Place of supply is the delivery address state; the seller state comes from the GSTIN (else the registered address). Same state -> CGST + SGST, else IGST. Calculations reuse `splitGst`/`splitInclusive` from `@cnote/billing` (round half up to the paisa, splits sum exactly) and `financialYear` for the Indian FY.
- **Numbering** reuses billing's approach: an `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on a counter row (`purchase_order_sequences`, key buyer business + FY) inside the issuing transaction. The row lock serialises concurrent issuers and a rollback releases the number, so there are no gaps.
- **GSTIN visibility.** The PDF is a document between the two parties and prints both full GSTINs (public data, needed to match tax invoices). On screen, a party sees its own full GSTIN and only the state code plus last four characters of the counterparty's (`maskGstin` from identity). Events and notification copy never carry GSTINs.
- **Invoices are limited to the PO value.** Recording an invoice that would take the live (non-withdrawn) total above the current PO total is refused; the buyer must amend the PO first. An amendment cannot go below what is already invoiced.
- **Withdrawing.** A seller can withdraw an invoice only while nothing is paid on it. The system withdraws unpaid invoices when the order is cancelled.
- **Payments** are the buyer's own records (part or full): amount, date, UTR/reference (6 to 30 letters and digits, unique per invoice). The invoice becomes `paid` when the sum equals the total.
- **Dates** without a time are Indian calendar dates (`@db.Date`, `istDate()`); instants are timestamptz. Zone-less `datetime-local` input is read as IST.
- **Uploads.** Invoice copies go to the private bucket under `invoices/supplier/...` (already private-only), type decided from magic bytes (shared `checkAttachment`), 5 MB cap, posted to a route handler with `readBoundedFormData` (server actions are capped at 2 MB). Served through authorised route handlers (signed URL or stream, never cacheable).
- **Feature flag.** `PURCHASE_ORDERS_ENABLED` (default on; `false`/`0`/`off` hides the screens, blocks writes and stops the reminder job; data is kept). Not Phase-2-ish: it moves no money.
- **Translations.** Web: `po` namespace (en, hi, plus the six catalogues kept on disk). Seller: `purchaseOrders` in all 8 locales. Domain errors stay English (they show in an alert), like other new modules.

## MSME rules (what is implemented and why)

Sources checked on 2026-10-06:

- [ClearTax: Section 43B(h)](https://cleartax.in/s/section-43bh-of-income-tax-act)
- [Tally: Section 43B(h) MSME payment rules](https://tallysolutions.com/accounting/section-43b-h-msme-payment-rules-compliance/)
- [TaxBuddy: Section 43B(h)](https://www.taxbuddy.com/blog/section-43bh-of-income-tax-act)
- [Paytm: Section 43B(h) and MSME payments](https://paytm.com/blog/income-tax/section-43bh-msme-payments/)
- Statute: Income Tax Act 1961 s.43B(h) (inserted by Finance Act 2023, from AY 2024-25) and MSMED Act 2006 s.15.

Rules as implemented:

| Rule | Implementation |
| --- | --- |
| Applies to **micro and small** enterprises only; medium is outside. | `Business.msmeCategory` is `micro`/`small`/`medium`, declared by the seller; only micro and small count. |
| Traders (pure wholesale/retail) are not covered; Udyam registration needed. | The declaration text makes the seller confirm they make goods or provide services (not a pure trader). Covered = micro/small **and** a valid Udyam number on file (`identity.getMsmeStatus`). Without Udyam the limit is not applied. |
| With a **written agreement** payment is due as agreed, **at most 45 days** from the day of acceptance or deemed acceptance. | The seller accepting the PO is the written agreement. Due date = acceptance date + `min(PO payment terms, 45)`. If the terms are longer the invoice says so ("capped"). |
| Without a written agreement: **15 days**. | PO not accepted when the invoice is recorded -> acceptance + 15. |
| **Day of acceptance** = day of delivery; deemed acceptance = the day after 15 days with no written objection. | Acceptance = the buyer's delivery confirmation (`orders.delivered_at`, set when the order moves to `delivered`). Until then the invoice date is used and the invoice says so; confirming delivery moves open invoices to the delivery date in the same transaction. Deemed acceptance is **not** modelled (the buyer confirms delivery in the app); this errs towards the buyer's own confirmation and is a follow-up if sellers need it. |
| Late payment: the expense is deductible only in the year actually paid. | Shown in reminder copy and the payables disclaimer. We do not compute tax. |
| MSMED Act s.16 interest (3x bank rate) on late payment. | Mentioned in the overdue notification; not computed. |

Every figure shown to a buyer is labelled seller-declared where relevant, and the page ends with "a reminder, not tax advice". The covered flag is **snapshotted on the invoice** when it is recorded (a later declaration does not reach back).

Reminders: `enquiry.payable-reminders` runs hourly in the module worker. For open covered invoices it emits `SupplierInvoiceDueReminder` once per stage: `t7` (7 to 2 days left), `t1` (1 day or due today), `overdue`. A `supplier_invoice_reminders` row is inserted in the same transaction as the event, so reruns and parallel workers send nothing twice. If the job was down, only the current stage is sent. `@cnote/notifications` turns the event into three templates (`payable.due_t7`, `payable.due_t1`, `payable.overdue`, English + Hindi defaults, edited in the template studio).

## E-invoice and e-way bill

Formats are validated (`po-core.ts`): IRN 64 hex (stored lowercase, unique across invoices), acknowledgement number 10 to 20 digits (IRP prints 15), e-way bill exactly 12 digits, signed QR 20 to 2900 characters, CGST Rule 46 invoice number (up to 16 characters: letters, digits, hyphen, slash; unique per seller and FY).

`EInvoiceVerifier` is a port (`einvoice.ts`): `verify({ irn, ackNo, signedQr, sellerGstin, invoiceNumber, invoiceDate, totalPaise }) -> { status: consistent | mismatch | unchecked, note }`. The default and only adapter is the **mock**: it decodes the NIC signed-QR JWT payload **without verifying the signature** and cross-checks IRN, document number, seller GSTIN, date and total (to the rupee) against what the seller entered. A mismatch is stored and shown to both sides as a warning; it does not block recording. **Future:** a GSP adapter (IRP signature verification with the NIC public key, "get IRN details" lookups, e-way bill validity) implements the same port and is wired with `setEInvoiceVerifier` at the composition root behind an env switch. No GSP call exists today, so no new secrets.

## Data model (`orders.prisma`, `identity.prisma`)

`purchase_orders`, `purchase_order_versions`, `purchase_order_lines`, `purchase_order_acks`, `purchase_order_sequences`, `supplier_invoices`, `supplier_invoice_payments`, `supplier_invoice_reminders`; `orders.delivered_at`; `businesses.msme_category`/`msme_declared_at`. Money is `BigInt` paise. Migration `20261005185626_po_einvoice_msme`.

## Events (versioned, in `catalog.ts`, all v1)

`PurchaseOrderIssued`, `PurchaseOrderAmended`, `PurchaseOrderAcknowledged`, `PurchaseOrderCancelled`, `SupplierInvoiceRecorded`, `SupplierInvoicePaymentRecorded`, `SupplierInvoiceVoided`, `SupplierInvoiceDueReminder`, `BusinessMsmeDeclared`. All emitted with `emit(tx, ...)` in the state-change transaction. Payloads carry ids, numbers and paise, never GSTINs or addresses.

## Notifications

Ten kinds in `packages/notifications/src/kinds-payables.ts`, all transactional ("messages" for PO conversation, "billing" for money), copy never names the counterparty: `po.issued`, `po.amended`, `po.accepted`, `po.rejected`, `po.cancelled`, `invoice.recorded`, `invoice.payment_recorded`, `payable.due_t7`, `payable.due_t1`, `payable.overdue`. English + Hindi seed content.

## Screens

- Buyer web (WCAG 2.2 AA, en + hi): order page panel; `/buyer/orders/[id]/purchase-order` (issue form, detail, versions and PDFs, invoices with Pay-by badges, e-invoice QR, e-way bill, payment form, amend, cancel); `/buyer/payables` (summary of open / overdue / due in 7 days, filter tabs, inline payment). Status is always text, never colour alone; tables have captions and header scopes; every control is labelled; targets are at least 44px on mobile. axe spec: `e2e/a11y/purchase-orders.spec.ts` (seed helper `seedPurchaseOrder` in `e2e/support/phase2-db.ts`).
- Seller app (8 locales): order page panel; `/orders/[id]/purchase-order` (answer the PO, record invoice incl. e-invoice and e-way bill fields, upload, withdraw); MSME declaration card in Settings -> Company.
- Admin: `/payables` (read-only overdue MSME payables, filter by days overdue, privilege `payables.read` for finance and support). No mutation, so no `audited()`.

### Mobbin references adopted

- PO detail with parties, payment terms, status chip and line table: [AWS Purchase Orders](https://mobbin.com/screens/fddbe2a7-4793-4ba2-9fe0-d1e02f142561), [Shopify PO](https://mobbin.com/screens/4d6a46fc-c238-457d-ad79-58d4ee90282d), [Xero PO editor](https://mobbin.com/screens/766554ee-3bc1-4a98-9939-bbf3e517dd7f) (delivery address block, terms, totals).
- Invoice record and payables list with due dates and overdue emphasis: [Xero Bills](https://mobbin.com/screens/4aca1a5f-6197-49a2-af60-38eda83be92c), [Shopify Bill Pay](https://mobbin.com/screens/5a2d171e-3dba-4cdf-b719-629c91e27ced), [QuickBooks Bills](https://mobbin.com/screens/66422a5f-2385-45ec-bc43-7a1953fc75e5) ("Mark as paid" row action), [Deel Payments](https://mobbin.com/screens/2b18ac2e-4083-483c-84b5-e955b2a2b5d1) ("Total to be paid / Total overdue" summary with "days ago").
- Adapted to `@cnote/ui` tokens; overdue uses text plus a danger badge, not colour alone.

## DPDP

- **Export:** the enquiry module's `exportPersonalData` now includes `purchaseOrders` (all versions, lines, acknowledgements, address snapshots; no storage keys) and `supplierInvoices` (references, payments; no storage keys). `msmeCategory` is part of the exported business row.
- **Retention:** `enquiry.po_documents_7y` (`RETENTION_PO_DOCUMENTS_DAYS`, default 2555) for closed POs and settled invoices: delivery contact name and phone are blanked (snapshot flagged `scrubbed`), PDF and uploaded invoice files are deleted; numbers, amounts, versions, e-invoice references and payments stay for GST / Income Tax record keeping.
- The invoice and PO files are private-bucket only and are opened per request by an authorised party.

## Not done / follow-ups

- Multi-line editing UI (data model and API are ready; waits for multi-line RFQs).
- Deemed acceptance (delivery + 15 days without written objection) and written objections.
- GSP adapter for the verifier; automatic e-invoice generation.
- MSMED Act s.16 interest calculation; tax computation.
- Seller-side receivables list page (sellers see invoices on each order; admin has the overdue view).
