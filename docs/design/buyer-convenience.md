# Buyer convenience (buyer web)

Status: implemented. Related: ADR-002 (contact only after accept), ADR-005 (lead credits), ADR-010 (DPDP), `docs/design/cookie-consent.md`.

## Mobbin references

- Recently viewed rail: Selfridges "Recommended for you" row (<https://mobbin.com/sites/sections/c691a953-a247-4986-b791-79326d0bdb1a>) and Fluz "Featured on products" (<https://mobbin.com/sites/sections/486dfdf5-8238-40c3-999e-ded6718d4f1a>). Adopted: heading above a horizontally scrolling row of image-first cards with title and price. Changed: renders nothing when empty, adds a "Clear history" control.
- Share list: Amazon "Invite others to your list" (<https://mobbin.com/screens/140507a5-d38e-425b-ab68-7e4795220fb1>), Epidemic Sound "Share playlist" (<https://mobbin.com/screens/c557a16c-730d-4bb8-99b4-1d2495f3ffd2>) and Dub "Share dashboard" (<https://mobbin.com/screens/35447e12-ec95-402e-8c53-d43ab8d3dedf>). Adopted: view-only wording, an explicit "who can see what" sentence, copy-link with a confirmation, and a way to switch sharing off. Changed: no edit-access option; the link carries no personal data.

## Contact options after unlock

"Unlocked" = the buyer has an enquiry whose match with the listing's supplier was **accepted** (the supplier spent a lead credit, ADR-002/005). `leadgen.completeUnlock` itself still never returns a number.

- `@cnote/leadgen`: `getUnlockedSupplierContact(personId, listingId)` and `recordSupplierContacted(personId, listingId, channel)`. Phone and email come from `identity.getPersonContact`, and are returned only if the supplier granted `counterparty_sharing` (their contact preference); otherwise only "Send enquiry" shows.
- `GET /api/contact/<listingId>`: signed-in only, `private, no-store`, `Vary: Cookie`. The static PDP and supplier profile render the existing unlock button; the `SupplierContact` island swaps it for Call (`tel:`), WhatsApp (`https://wa.me/<digits>?text=` naming the product), Email (`mailto:`) and Send enquiry after the fetch. The number is never in static HTML.
- `POST /api/contact/<listingId>` logs `SupplierContacted` v1 (ids and channel, never the number); the unlock is re-checked server side; same-origin only.

## Recently viewed

Device-local list of the last 12 product ids (30 days) in `localStorage["cnote_recent_v1"]`. Not strictly necessary, so it is stored only with the **marketing and attribution** consent (otherwise memory only, so nothing is remembered across pages). A dedicated "preferences" category would change the cookie format, the receipt table and the account ledger, so it is deferred; the registry, notice text (`marketingDesc`, `purpose.recentlyViewed`) and policy version (now 2, snapshot `v2.json`) say so plainly. No server sync (nothing to erase; the ids never leave the device). The rail is a client island on the home page and the PDP and reads public facts from `GET /api/recently-viewed?ids=` (stateless, live listings only).

## Wishlist

- Bulk quotes: checkboxes + "Request quotes for selected" call the existing `createEnquiry` once per supplier (`preferredSellerId`, max 20 products and 5 suppliers per action; private notes are not sent). Matching and credits stay in `@cnote/enquiry`.
- Share: `WishlistShare` (one row per list, 256-bit token, deleted on revoke or cascade on list/person erasure). Public page `/shared/<token>` shows the list name and public product facts only, is `noindex`, `no-referrer`, dynamic.
