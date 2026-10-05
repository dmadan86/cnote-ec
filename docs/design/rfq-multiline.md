# Multi-line RFQ (bill of materials) with per-line quoting and award

Per ADR-002 (limited, transparent matching), ADR-007 (lifecycle, event log, paise), ADR-008 (all AI through capabilities and the user-input envelope), ADR-010 (private data), WCAG 2.2 AA on the buyer web. Builds on `rfq-quotes.md`.

## Mobbin research (cited)

- Editable line items: [HoneyBook invoice](https://mobbin.com/screens/fdaf70fd-4837-4cbc-b658-d25296ce7bc0) ("Add a new service" under the list), [QuickBooks invoice](https://mobbin.com/screens/8c6e5809-f27c-403e-8055-5007b16d5b81) (numbered rows with a drag handle and a delete icon), [Pipedrive products](https://mobbin.com/screens/8d93ba09-a3c2-4380-9d55-9350a7a0cce1) (totals summary under the rows), [Square variations](https://mobbin.com/screens/b8a54940-cacf-4cd7-be3b-70d90a0901f1). Adopted: numbered lines, "Add another line", per-line remove, a running count. Drag handles are replaced by labelled Up/Down buttons (keyboard and touch operable).
- Upload with column mapping: [Clay import CSV](https://mobbin.com/screens/0c381ad4-043a-4ec9-a894-afc209962a28), [Attio map columns](https://mobbin.com/screens/c1100b84-0dd6-4bee-9bc9-05a8a2ea3fec), [Copy.ai map columns](https://mobbin.com/screens/0ff9041a-e81a-404a-b4a0-38fa42ffc2cb). Adopted: a mapping step after upload (one select per target field, required fields starred, sample value shown in each option), auto-detected from header synonyms, with "Add to my items" / "Replace my items" and a skipped-rows report.
- Comparison matrix: [Relevance AI comparison](https://mobbin.com/screens/e0501a17-5d16-464a-bc12-16e4f58a4b78), [Synthesia compare plans](https://mobbin.com/screens/28175899-b402-4c29-970f-18234411d48c), [Airwallex plans](https://mobbin.com/screens/03a25b36-417f-4e01-ab26-36ea3caa709d). Adopted: one column per option, one row per item, the best value flagged by a chip. Our chip is the word "Lowest" with a star, never colour alone.

## Data model (module `enquiry`)

- `EnquiryLine` (1..50 per enquiry; ordinal, item name, spec, quantity, unit, target price paise, category id, HSN). Line 1 mirrors `Enquiry.quantity/quantityUnit/targetPricePaise`, and `Enquiry.title` is the RFQ title, so matching, intent scoring, search and the public API keep working unchanged.
- `QuoteLine` (per quote and requirement line: unit price paise, GST rate %, lead time, can't-supply flag, note, quantity, server-computed subtotal/GST/total). `Quote` gets `lineSubtotalPaise/lineGstPaise/lineTotalPaise/quotedLineCount`; `pricePaise/quantity/unit` mirror the first priced line.
- `EnquiryLineAward`: per-line award with an immutable snapshot (item, spec, HSN, quantity, unit, price, GST, lead time, totals) and the `orderId` of the supplier's order.
- Migration `rfq_multiline_lines` creates the tables and backfills one line per existing enquiry (idempotent `NOT EXISTS` insert; legacy rows without a quantity become 1 "unit"). Child tables cascade on parent delete.

## Behaviour

- Create: `createEnquiry({ lines })`. With lines the title and description may be omitted (derived). Every line's text goes to moderation, embedding and intent scoring as ordinary requirement text, i.e. inside the existing `userInputEnvelope` (no prompt change, so no eval-gate bump). Unknown or prohibited line categories reject the RFQ.
- Quote: `sendQuote({ lines })`. All maths is server-side, in BigInt paise, half-up rounding. If the quote says GST included, the price contains GST; otherwise GST is added per line. Partial quotes are allowed; at least one priced line is required; a multi-line RFQ refuses a single-price quote.
- Compare: `getQuoteComparison` returns lines, per-quote coverage ("2 of 3 lines"), `lowestByLine` (ties all listed, can't-supply and skipped lines never win) and existing awards. A partial quote's total and a per-line quote's unit price are excluded from the supplier-level "Best" marks, since they are not comparable.
- Award: `awardLines(actor, enquiryId, [{ enquiryLineId, quoteId }])`, one transaction: only the buyer; only the supplier's latest quote; only lines the quote priced; a line at most once; a supplier that already has an order takes no more lines. Per supplier it records a buyer-confirmed `won` deal report at the sum of the line totals, one Order (`quantity/unit/price` null, `lineItems` mode), the award snapshots and a `LinesAwarded` event. `decideQuote(accept)` on a per-line quote awards its still-open priced lines.
- For purchase orders: `getAwardedLines(orderId)` returns the immutable line snapshots ordered by line number (`AwardedLine`); `listAwardedLines(actor, enquiryId)` is the buyer's view.

## Events

`EnquiryCreated` v3 (+`lineCount`), `QuoteSent` v2 (+`lineCount`, `totalPaise`), new `LinesAwarded` v1. Added fields are optional, v1/v2 rows keep their shape.

## UI

- Buyer `/rfq/new`: "How many items?" radio (one item, or several). Several shows the BOM editor: a fieldset card per line (stacked on mobile, 6-column grid from `sm`), Up/Down/Remove buttons with `aria-label`s naming the line, focus kept on the moved control, polite announcements, per-field errors on blur, 50-line cap. Upload posts to `POST /api/rfq/bom` (auth first, rate limited, `readBoundedFormData` 1 MB, excluded from the proxy matcher like `/api/rfq`); `GET` serves the CSV template. Parsing reuses `@cnote/bulk` (`readSheetMatrix`: magic-byte format detection, encoding and delimiter detection, xlsx zip-bomb guard); formulas are never evaluated, and imported text has leading `= + @ TAB CR` (and a non-numeric `-`) stripped. The editor posts a `lines` JSON field; the server re-validates everything.
- Buyer `/buyer/enquiries/[id]`: items table (when more than one line) and the line-by-line matrix (table from `md`, one card per line on mobile, shared selection state, radios labelled "Award line N (item) to supplier", summary of lines/suppliers/total, one order per supplier).
- Seller conversation page: per-line price cards (price, GST rate, delivery days, can't supply, note; empty = skipped) with a live estimate; the lead card lists the lines.
- Strings: web `rfqLines` namespace (en, hi, six machine-drafted locales), seller `rfqLines` (8 locales).

## API

`POST /v1/enquiries` and `POST /v1/conversations/{id}/quotes` accept `lines`; reads return `lines` (enquiry), `lineTotals` and `lines` (quote). New `POST/GET /v1/enquiries/{id}/awards`. MCP: `create_enquiry` and `send_quote` take `lines`; new `award_lines`. `docs/api/openapi.json` regenerated.

## Decisions

- Mode switch instead of a hybrid form: in "several items" the single quantity/unit/price fields are replaced by the editor, so line 1 is never ambiguous.
- Lines are cards, not a table, in the editor: every control keeps a visible label and works at phone width; the comparison is a real table because it is read-only plus radios.
- One order per supplier per RFQ (existing `Order.matchId` uniqueness): awarding more lines to a supplier that already has an order is refused rather than silently amending an order.
- Single-field quotes on single-line RFQs stay as they were (no synthetic `QuoteLine`), so nothing legacy changes.
- Unit price for compare is the payable line total (GST-aware) so suppliers quoting inclusive and exclusive prices compare fairly.
- Not done: editing an RFQ's lines after posting, un-awarding, a column-mapping memory, and drag-and-drop reordering.
