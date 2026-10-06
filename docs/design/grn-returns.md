# Goods receipt notes, three-way match and returns

Status: built, on with `PURCHASE_ORDERS_ENABLED` (it extends the purchase-order feature, `docs/design/purchase-orders.md`). Owner: `@cnote/enquiry` (orders sub-module). Phase 1 settles off-platform (ADR-007): these are records and controls; the only money movement is the optional escrow refund, which exists only when escrow is on and funds are held.

## What it does

1. **Goods receipt note (GRN).** The buyer records what arrived against a PO: per PO line the quantity received, rejected (with a reason code: damaged, short, wrong spec, quality fail, plus a note) and accepted (= received - rejected), the received date (today or up to 60 days back), the receiver's name, an optional delivery challan / LR number and up to five photos. One PO can have many partial GRNs. Numbers are gap-free per buyer business and financial year (`GRN/26-27/000004`). A GRN is never edited: a correction is another GRN or a return.
2. **Delivery confirmation and s.43B(h).** The first GRN with accepted units is the buyer's delivery confirmation: a `dispatched` order moves to `delivered` (one `OrderStatusChanged`, so escrow milestones keep working) and `orders.delivered_at` is stamped with the received date. Open invoices recorded earlier move from the invoice date to that day of acceptance through the existing `onOrderDeliveredTx`. If delivery was already confirmed (manually, or by an earlier GRN) nothing changes, so acceptance is never double counted. The event says whether this GRN confirmed delivery.
3. **Three-way match.** PO vs GRN accepted quantity vs supplier invoice. Status per line and per invoice: `matched`, `within_tolerance`, `mismatch`, `pending_grn`. A mismatch blocks "mark paid" unless the buyer pays anyway with a reason (5 to 300 characters), which is logged in `invoice_match_overrides` and emits `InvoiceMatchOverridden`. Both sides see the match; only the buyer sees the gate and the override reasons.
4. **Returns (RMA).** From a GRN the buyer requests a return of rejected units and/or accepted units within the return window. The seller approves or rejects (a rejection needs a reason). Approved: the buyer records the shipment (courier, tracking/LR number), the seller confirms the goods are back and records a **credit note** (number, date, taxable, GST, optional IRN) against an invoice, which reduces the payable. A rejected return can be taken to a dispute.
5. **Escrow.** `ReturnCreditNoteRecorded` makes `@cnote/escrow` refund the buyer from funds still held, up to the credited amount (clamped to what is held). Idempotent per credit note (`escrow_return_refunds`). While a dispute freezes the escrow nothing moves and a reconciliation issue is opened for ops. After release the credit only reduces the invoice payable.
6. **Disputes.** Linked, not rebuilt: the buyer's "open a dispute" button on a rejected return calls `openDispute` of `@cnote/disputes` (type mapped from the return reason, description carrying the return number and the seller's reason) and stores the id with `linkReturnDispute`. Evidence, mediation and escrow freezing are the disputes module's.

## Decisions

- **No new order status; the order must be dispatched.** Goods can be received when the order is `dispatched`, `delivered` or `completed`. A `confirmed` order is refused with a message telling the buyer to ask the seller to mark it dispatched: that keeps one lifecycle (`OrderStatus`) and avoids a `delivered_at` on an order that cannot become delivered.
- **Accepted is derived.** The form takes received and rejected; accepted is shown live and checked on the server (`accepted + rejected = received`). The API also takes `acceptedQty` and requires consistency.
- **Over-delivery** is accepted up to the ordered quantity plus the buyer's quantity tolerance, cumulative over receipts. Beyond that the receipt is refused (the buyer returns the surplus at the door).
- **Receipts attach to the current PO version's line numbers** (`lineNo` is stable across amendments). Unit prices are snapshotted on the receipt line (net of GST: taxable / quantity) so returns and credit estimates survive later PO amendments.
- **Numbering** reuses the PO approach through one `document_sequences` table keyed by (buyer business, kind `grn` | `rma`, financial year): an upsert whose row lock lives until the creating transaction ends, so rollbacks leave no gap.
- **Photos** go through `app/api/goods-receipts` (multipart, `readBoundedFormData`, own cap, excluded from the proxy matcher like disputes), type decided from magic bytes by `checkAttachment` (JPG/PNG only here), stored in the private bucket under `grn/<receiptId>/...` (new private-only media prefix) and served by authorised route handlers (signed URL or stream, no-store). There is no attachment malware scanner on this branch; the magic-byte check and private storage are the controls, and a scanner hook belongs in `checkAttachment` when one exists.
- **Supplier invoices stay amount-first.** Optional line detail (`supplier_invoice_lines`: PO line, quantity, unit price before GST) is accepted at record time and must add up exactly to the taxable value. With lines the match is per line; without, it is per invoice on value. The seller form offers a collapsible "bill by purchase order line" section.
- **Match rules** (`match-core.ts`, pure and unit-tested):
  - Quantity: the quantity billed so far on the PO (this invoice and earlier live invoices, less credited rejected units) against the quantity accepted over all receipts. Billing less than accepted is `matched` (the rest is billed later). Billing more is `within_tolerance` up to the quantity tolerance, else `mismatch`; if nothing was accepted, any billing is a mismatch.
  - Price: invoice unit price against the PO net unit price, either direction, against the price tolerance.
  - A line's status is the worse of its quantity and price status; an invoice's status is the worst of its lines. Without lines, the cumulative taxable value billed (less credited rejected value) is compared with the value accepted at PO prices using the two tolerances compounded.
  - No receipt on the PO: `pending_grn`. A line referring to a PO line that does not exist: `mismatch`.
  - A credited return of **rejected** units stops counting as billed (that is how a credit note cures an over-billed invoice); a credited return of **accepted** units changes neither side (the invoice stays as issued; the credit reduces the payable).
- **Tolerances per buyer business** (`buyer_match_settings`, 0 to 20%, defaults 2% quantity and 1% price from `MATCH_DEFAULT_*_BPS`). A buyer can also choose to block "mark paid" while no GRN exists (`blockPendingGrn`, default off, because advance and on-delivery terms are normal).
- **The override is bound to the numbers the buyer saw.** The override stores a fingerprint of the per-line figures; part payments with the same figures need no new reason, but a further receipt, invoice or credit that changes the figures re-blocks. Overrides are append-only in the application (no update or delete path); no database trigger was added.
- **Credit notes reduce the payable** through `supplier_invoices.credited_paise`: outstanding = total - credited - paid. An invoice whose payments plus credits cover its total becomes `paid` (settled). If the buyer had already paid more than the invoice is now worth, `refundDuePaise` shows what the seller owes back (off-platform). The credit is capped at the invoice value not yet credited. One credit note per return; the platform does not issue credit notes, it records the seller's. MSME reminders stop for settled invoices.
- **Return window**: `RETURN_WINDOW_DAYS` (default 30, 1 to 365) counted from the received date, inclusive, for both rejected and accepted units. It is platform config, not per seller; a per-seller or per-category policy can replace the function without schema change.
- **Units held by returns**: requested, approved, shipped, received and credited returns hold their units; cancelled and rejected returns release them.
- **State machine** (`RETURN_TRANSITIONS`, pure): buyer cancels while `requested`; seller approves or rejects from `requested`; buyer ships from `approved`; seller marks received from `approved` or `shipped`; seller records the credit note from `approved`, `shipped` or `received` (no need to wait for the goods); dispute only from `rejected`. Non-participants see "not found".
- **Dispute link is trusted, not verified.** `@cnote/enquiry` cannot read dispute rows (ADR-006), so `linkReturnDispute` only checks the shape of the id; the web action opens the dispute first and links the id it got back. The link is shown only to the two parties, and the disputes module authorises the dispute page itself.
- **Events** are versioned in the catalogue (all v1): `GoodsReceiptRecorded`, `InvoiceMatchOverridden`, `GoodsReturnRequested`, `GoodsReturnDecided`, `GoodsReturnCancelled`, `GoodsReturnShipped`, `GoodsReturnReceived`, `ReturnCreditNoteRecorded`, `GoodsReturnDisputeLinked`. `EscrowRefunded.cause` gains `return_credit`. All are emitted with `emit(tx, ...)` in the state-change transaction; payloads carry ids, numbers and paise, never names, notes or reasons.
- **Notifications** (`kinds-grn.ts`, English + Hindi defaults, editable in the template studio): `grn.recorded`, `return.requested`, `return.approved`, `return.rejected`, `return.shipped` (messages) and `return.credit_note` (billing).
- **No approvals dependency.** The override is a reason, not an approval workflow; if an approvals module lands, the gate in `matchGateTx` is the place to call it.

## Data model (`orders.prisma`, `escrow.prisma`)

`document_sequences`, `goods_receipts`, `goods_receipt_lines`, `goods_receipt_photos`, `supplier_invoice_lines`, `buyer_match_settings`, `invoice_match_overrides`, `goods_returns`, `goods_return_lines`, `return_credit_notes`, `supplier_invoices.credited_paise`, `escrow_return_refunds`. Migration `20261005195306_grn_returns_match`. Quantities are whole units, money is `BigInt` paise.

## Screens

- **Buyer web** (WCAG 2.2 AA, en + hi; the other six catalogues are kept on disk): order page shortcuts; `/buyer/orders/[id]/receipts` (progress table, receipt form, recorded receipts with photos and the return window); `/buyer/orders/[id]/match` (order/receipt/billed table, per-invoice comparison, blocked-payment note, logged overrides, tolerance form); `/buyer/returns` (open / all), `/buyer/returns/new?receipt=` (request form), `/buyer/returns/[id]` (status, shipment form, withdraw, dispute entry). Invoice cards and payables show the match status; the pay form asks for a reason when blocked. Status is always text, never colour alone; tables have captions and header scopes; every control is labelled; targets are 44px on mobile. axe spec: `e2e/a11y/grn-returns.spec.ts` (seed helper `seedGoodsReceipt`).
- **Seller app** (8 locales): `Returns` in the navigation; `/returns` (inbox with open / all and an action-needed count); `/returns/[id]` (approve / reject with note, confirm goods received, record the credit note against one of the seller's invoices); the seller PO page lists the buyer's receipts (accepted / rejected / photos) and the per-invoice match; the invoice form can bill by PO line.

### Mobbin references adopted

- Receive-goods table (ordered / received per line, auto-fill): [Fresha receive order](https://mobbin.com/screens/a105efa0-23b4-45ec-88ce-13f550f7d8a7); PO lines with supplier, quantity and cost beside a summary rail: [Shopify purchase order](https://mobbin.com/screens/4d6a46fc-c238-457d-ad79-58d4ee90282d).
- Reason picker plus free text and optional evidence upload, then a clear "requested, answered within..." confirmation: [Whop refund request](https://mobbin.com/flows/5044d298-01fa-43ff-8672-ff51294f12bb); request, approved state with the reason shown back: [Unity refund request and history](https://mobbin.com/flows/ea396a65-aa45-4320-b6f0-c9de5c6d8e23); choosing items and a reason from a list: [Amazon cancel items](https://mobbin.com/flows/10a86509-4147-42e1-9d93-933efc4d86b4).
- The "invoice matching discrepancies" search timed out on Mobbin; the match view follows the per-line comparison table of the purchase-order references in `purchase-orders.md` with text status badges.
- Adapted to `@cnote/ui` tokens; overdue/mismatch uses text plus a danger badge.

## DPDP

- **Export:** the enquiry `exportPersonalData` now carries `goodsReceipts` (receiver name, lines, reason codes, photo metadata without storage keys), `goodsReturns` (lines, credit notes), `invoiceMatchOverrides` (the person's reasons) and `matchSettings`.
- **Retention:** `enquiry.grn_photos_7y` (`RETENTION_GRN_PHOTOS_DAYS`, default 2555) for receipts of completed or cancelled orders: photos are deleted (files and rows) and the receiver's name is erased; quantities, reason codes, numbers and dates stay for GST / Income Tax record keeping. Returns, credit notes and overrides hold no extra personal data beyond free-text notes the parties wrote; these are covered by the export.
- Photos are private-bucket only, opened per request by the two parties.

## Cookie consent

No new cookie or storage key; `CONSENT_POLICY_VERSION` is unchanged.

## Not done / follow-ups

- Scanning uploaded photos for malware (no scanner exists yet).
- Per-seller or per-category return policies and restocking fees; partial-quantity credit notes per return line (one credit note per return today).
- Multi-line PO editing (waits for multi-line RFQs); amending a PO below what was received is not blocked.
- Deemed acceptance and written objections (see `purchase-orders.md`).
- An escrow auto-release deferral while a return is open (a dispute is the freeze mechanism today).
- A database trigger making `invoice_match_overrides` append-only.
- Buyer-side CSV export of GRNs for accounting software; barcode scanning.
