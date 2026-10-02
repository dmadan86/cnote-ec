# Product detail page upgrades

Covers quantity price tiers, trade info, the gallery lightbox, share, report link and the sticky mobile CTA bar on
`apps/web/src/app/[locale]/(discover)/p/[slugId]/page.tsx`. The seller card / trust panel is owned elsewhere and untouched.

## Design research (Mobbin)

- Tiered price selector next to a summary of what each tier includes: [Upwork service tiers](https://mobbin.com/screens/991b914e-8507-4606-974f-511a48181cdb). Adopted: a compact selector with the active tier clearly marked and a single primary action under it. Changed: tiers are quantity slabs in a real `<table>` (row headers, caption), and the active row carries a text label ("Your tier"), not only colour.
- Price comparison with a footnote for tax: [Whereby pricing](https://mobbin.com/screens/abc979c9-efef-4f0d-a0d3-a51fd59e7f0e) ("All prices are in USD, excl VAT"). Adopted for the estimate: "Estimate, excl. GST" sits directly under the total.
- Lightbox: [Turo](https://mobbin.com/screens/423ee5a0-c146-4516-99f3-8ef619c249fa) ("1 of 6" counter, side arrows, close), [Care.com](https://mobbin.com/screens/3efcd915-240f-4a52-881e-270f3941cd49) (thumbnail strip), [Pinterest](https://mobbin.com/screens/bf91f50d-a2c4-49de-9b22-06ba817d0d8c) (plus/minus zoom buttons). Adopted: full-screen black viewer, visible counter, prev/next, zoom buttons.
- Link-copied confirmation as a small toast: [Savee](https://mobbin.com/screens/430f66ac-18c1-42c4-81ea-5e14bf67fb94). Adopted, but also announced through a persistent `role=status` region.

## Data model (ADR-007, listing versions)

- `Listing.priceTiers` (JSON `[{minQty, pricePaise}]`, integer paise as safe-integer numbers like the version snapshot) plus scalar trade columns: `leadTimeDays`, `packaging`, `sampleAvailable`, `samplePricePaise` (BigInt), `supplyCapacityPerMonth`, `paymentTerms`, `certifications[]`. One migration (`listing_price_tiers_trade_info`).
- Both are part of `VersionSnapshot` (optional, so old snapshots parse), diffed in the version history, and projected to LIVE as `live_listings.price_tiers` / `trade` (JSONB; live-db migration `listing_tiers_trade`). `ListingView.priceTiers` / `.trade` are optional.
- Validation (`validatePriceTiers`, `@cnote/catalogue`): minQty strictly ascending, first slab >= MOQ (>= 1 without MOQ), prices non-increasing, at most 8 slabs. Checked on create and on any update touching tiers or MOQ.
- Buyers see tiers only after a version is approved and published, like every other field.

## Page behaviour

- `PurchasePanel` (client island) holds the quantity. It defaults to the MOQ, picks the slab (`features/pdp/tiers.ts`; below the first slab the listing's base price covers MOQ..first-1), highlights the row (`aria-current`, "Your tier"), and shows `unit paise x qty` computed with BigInt, formatted to rupees only at display. A polite `role=status` announces each change. GST is excluded and says so; the GST rate is not shown because no HSN-to-rate config exists.
- "Request quote" carries `qty`, `unit` and the slab `price` to `/rfq/new`, which pre-fills quantity, unit and target price. "Get best price" creates the enquiry immediately, so there is nothing to prefill.
- Trade block shows unit, MOQ, HSN and the optional fields; a missing field is not rendered. HSN and MOQ moved out of the specifications table into it.
- Gallery: native modal `<dialog>` (focus trap and restore, Esc), Left/Right/Home/End, `+`/`-`/`0` zoom, zoom buttons, pinch and drag via CSS transform, counter in an aria-live region. Blur-up is unchanged (BlurImage). Video is not modelled on listings, so it is skipped.
- Share: disclosure with the Web Share API entry when `navigator.share` exists, WhatsApp (`wa.me`), e-mail, copy link with a `role=status` confirmation. Shares the canonical absolute URL.
- "Report this listing" links to `/report?url=<canonical>`.
- Sticky bar (below `md`): appears while the in-page buttons are off screen. `globals.css` adds body padding and scroll-padding while it is mounted; with the cookie banner it sits above the banner (`bottom: var(--consent-banner-h)`) and both heights are added.

## i18n

`apps/web/messages/<locale>.pdp.json` (8 locales), registered in `KNOWN_NAMESPACE_FILES` and `CLIENT_NAMESPACES`. Seller form strings are in `apps/seller/messages/<locale>.listings.json` (`editor.*`, `actions.*`).
