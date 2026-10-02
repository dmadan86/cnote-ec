# RFQ depth and buyer quote comparison

Per ADR-002 (limited, transparent matching), ADR-007 (lifecycle, event log), ADR-008/010 (no attachments to models, private storage), DESIGN.md tokens, WCAG 2.2 AA on the buyer web.

## Mobbin research (cited)

- Attachments on a form: [Square, New estimate](https://mobbin.com/screens/febc47c5-81eb-44d7-9ab8-911abea48ba7) (optional "Attachments / Add attachment" row in a details block), [DoorDash Merchant, upload menu](https://mobbin.com/screens/95a1f965-cc6b-44fb-95ea-10f601470555) (states the accepted types, PDF/PNG/JPEG, next to the control) and [HoneyBook, file upload question](https://mobbin.com/screens/ab1b65c6-5c79-4eb5-860f-74bcef6ae542) (limits shown as "max size, types, number of files"). Adopted: one optional "Optional details" group, the limits written beside the control, and a removable list of chosen files. We state limits in the hint and re-check them in the page before upload.
- Budget as a bounded choice: [Calendly lead form](https://mobbin.com/screens/4110e784-1731-4975-b637-b6b20379a1c7). Adopted: budget is asked as a range, never required.
- Side-by-side comparison: [v0 Compare Plans](https://mobbin.com/screens/04afb769-5747-44bd-8831-873cd07b4850) (feature rows, one column per option, plain table) and [Higgsfield plan comparison](https://mobbin.com/screens/6a7ec354-b52f-4fe6-a6ff-20eda257b4b4) (the best value in a row is marked with a chip). Adopted: one row per supplier (quotes have 11 attributes, so suppliers are rows, not columns) and a "Best" chip that is text, not only colour.

## Requirement (`/rfq/new`)

New optional fields: budget min/max per unit (paise), "Accept quotes for" 1 to 30 days (default 7, sets `Enquiry.expiresAt`), preferred supplier verification (`minSellerTier`, a hard floor applied before ranking, using real tiers per ADR-003), up to 5 drawings (PDF/JPG/PNG, 10 MB each). Delivery pincode is prefilled from the `cnote_pincode` cookie; the buyer's typing wins. Target price, pincode and required-by already existed.

Attachments:

- Type is decided from magic bytes (the file name and declared type are ignored), size and count are checked before any model call or write.
- Bytes go to the PRIVATE media bucket, `rfq/<enquiryId>/<uuid>.<ext>` (new private-only prefix). The key never contains the user's file name.
- Read only through `openAttachment(actor, id)`: the buyer, a seller holding an offered/accepted lead on the requirement, or the quoting seller (quote attachments). Remote drivers answer with a 5-minute signed URL, the local driver streams. Routes: `/api/rfq-attachments/[id]` in apps/web and apps/seller, `Cache-Control: private, no-store`.
- `@cnote/media` provides type sniffing only. It has no antivirus scan, so there is none; a scanning port is the natural follow-up.
- AI: `scoreIntent`/`moderate` receive text and numbers only. A test asserts the model input has no attachment data.

Events: `EnquiryCreated` is bumped to v2 (adds optional `attachmentCount`, `minSellerTier`, `expiresAt`; the v1 shape is unchanged for old rows).

Expiry: derived, not swept. `boardStatus()` treats a requirement past `expiresAt` as expired, so no job can leave a stale status. Sellers cannot accept a lead after the deadline. Legacy rows have no expiry.

## My requirements (`/buyer/enquiries`)

Status chips are links (`?status=`), with counts and `aria-current`. Status: closed/rejected, else expired (past deadline), else quoted (quotes > 0), else open. Each card shows quotes received, "N of max N suppliers matched" where N is the number of suppliers currently holding the lead (so "0 of max 3" is shown honestly when nobody matched), and a live "Expires in 3d 4h" (updates each minute; "Expired" replaces it).

## Quote comparison (`/buyer/enquiries/[id]`)

Transparency line (ADR-002): "Sent to N suppliers; you are seeing quotes from M" (N = every match ever offered, M = suppliers who quoted). Latest quote per supplier is compared; replaced quotes are noted.

- Table, md and up: supplier, verification tier, rank (of N), unit price, total for the requested quantity (unit price x quantity; the quoted quantity when the buyer gave none, labelled; delivery charge shown separately), lead time, validity, payment terms, attachments, notes, actions. Scrollable region is focusable and labelled.
- Sort (rank, price, total, lead time, verification) with a polite live announcement; "Best" per column with a visible word and screen-reader column name; shortlist toggle (`aria-pressed`, stored on `Quote.shortlistedAt`, buyer-only) and "shortlisted only" filter.
- Actions: Accept and Decline call `decideQuote`, which records the existing off-platform deal report (ADR-007): accept = "won" at the server-computed total (creates the Order record), decline = "lost". Message links to the conversation.
- Mobile: stacked cards in a scroll-snap strip (swipe, or Previous/Next buttons; smooth scrolling is turned off under `prefers-reduced-motion`). Targets are 44px.

Strings: `apps/web/messages/<locale>.rfq2.json` (en and hi; six others machine-drafted and marked). Seller strings: `apps/seller/messages/<locale>.rfqLead.json`.
