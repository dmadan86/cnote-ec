# Seller onboarding research (Phase 1)

Scope: how Indian and global marketplaces onboard sellers, what is required vs deferrable, where sellers drop off or complain, and what that means for `apps/seller`. Secondary sources (blogs, guides, review sites) were used; they are third-party summaries, not platform policy, so treat specifics as indicative and re-verify before quoting externally. No figures below are our own measurements. Not covered in depth: TradeIndia, Udaan and JioMart (only incidental hits), Shopify Payments-style KYC.

## Sources

| # | Topic | URL |
|---|---|---|
| 1 | IndiaMART registration, GST optional for free listing, 3-product minimum | https://blog.shipway.com/indiamart-seller-registration-login-guide/ , https://www.shiprocket.in/blog/indiamart-seller-guide/ |
| 2 | IndiaMART seller help centre | https://help.indiamart.com/knowledge-base/how-to-sell-on-indiamart |
| 3 | Flipkart Seller Hub steps, GSTIN/PAN/bank/name-match, token deposit, 24-72h review | https://swcybernetics.in/guides/flipkart-seller-registration , https://okaygst.com/blog/flipkart-seller-registration-guide/ |
| 4 | Meesho supplier steps, GST optional in non-GST categories | https://supplier.meesho.com/learning-hub/lessons/how-to-register-on-meesho-lesson , https://swcybernetics.in/guides/sell-on-meesho |
| 5 | IndiaMART seller complaints (fake leads, same lead to many sellers, refund refusals) | https://www.trustpilot.com/review/m.indiamart.com , https://www.complaintsboard.com/indiamart-b124473 , https://indiamart.pissedconsumer.com/review.html |
| 6 | Penny drop / reverse penny drop and onboarding drop-off | https://hyperverge.co/blog/what-is-penny-drop/ , https://www.proteantech.in/articles/bank-account-verification-02-06-2025/ |
| 7 | ONDC seller-app onboarding checklist (GST, PAN, location, phone, catalogue), 3-7 day verification wait, Sahayak vernacular bot | https://www.digicommerce.in/blog/ondc-seller-onboarding-guide/ , https://www.proteantech.in/articles/ondc-seller-registration/ |
| 8 | Alibaba Gold Supplier is paid; Verified Supplier needs third-party audit; trust badges criticised | https://www.alibaba.com/help/gold_supplier.html , https://qualityinspection.org/alibaba-gold-supplier/ |
| 9 | GSTIN structure and mod-36 checksum | https://dev.to/tarun_vaghasia_a387e1ac9b/how-gstin-checksum-validation-works-and-why-it-isnt-enough-3l8e , https://github.com/tk120404/gst |
| 10 | DPDP s.6(3) plain-language consent, Eighth Schedule languages; DPDP Rules 2025 rule 3 itemised, standalone notice | https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023 , https://www.certinal.com/blog/multilingual-consent-under-dpdp-act |
| 11 | WhatsApp voice notes and vernacular for small sellers | https://watease.com/whatsapp-commerce-india |
| 12 | Shopify/SaaS onboarding: 3-5 step checklists, progress indicator, activation window | https://www.candu.ai/blog/shopify-onboarding-flow , https://kompassify.com/blog/how-to-create-a-user-onboarding-checklist |
| 13 | Amazon India: GST needed before first sale, video verification | https://swcybernetics.in/knowledge-base/amazon-seller-registration-india-2026 |

## Findings

| Theme | What competitors do | Implication |
|---|---|---|
| Step order | IndiaMART: phone OTP, basic business info, email, then at least 3 products to activate the free page (1, 2). Flipkart: OTP, GSTIN, pickup address, signature, bank, then first listing (3). Meesho: OTP, GSTIN, pickup, bank (4). ONDC: legal docs, location, contact, catalogue (7). | Marketplaces that carry logistics or payouts front-load KYC. Lead marketplaces (IndiaMART) let sellers in with phone + basics. We are a lead marketplace, so identity and listing come first, verification later. |
| Required vs deferrable | GST optional on IndiaMART free tier and for non-GST categories on Meesho (1, 4); mandatory on Flipkart/Amazon (3, 13). Bank account matters only when money moves. | Phase 1 has no payouts (ADR-001), so bank/penny-drop is not needed and is out of scope. GSTIN is deferrable: T0 sellers can list but are shown as Unverified. |
| Drop-off causes | Name mismatch between GST, PAN and bank is where most Flipkart registrations fail (3). Waiting for verification (24-72h, up to 3-7 days on ONDC) (3, 7). Slow verification flows lose users who are asked to come back later (6). Long setup wizards before value, no progress indicator (12). | Verify GST instantly (single API call, inline result), never block on manual review, show progress, keep to 5 steps. |
| Time to first listing | IndiaMART needs 3 products before the page is live (1). Shopify guidance: 3-5 checklist items; activation not reached in 72h is high churn risk (12, vendor claims). Catalogue creation is the largest drop-off (ADR-004). | One listing (not 3) to go live; AI drafts it from one free-text message; editable form, one tap to publish. Measure time-to-first-listing (ADR-004 metric). |
| Vernacular / low literacy | WhatsApp is the native channel; voice notes and any Unicode language are first-class (11). ONDC ships a five-language WhatsApp helper bot (7). DPDP requires consent requests in plain language, available in English or an Eighth Schedule language (10). | Hinglish/Hindi examples in the AI box, short sentences, big touch targets. Voice and WhatsApp are the primary path (ADR-004); the web wizard is the tertiary path, so it must be short and resumable. Language picker stored on the business. |
| Trust presentation | Alibaba Gold Supplier is a paid tier and is widely criticised as meaningless as a quality signal; Verified requires third-party audit (8). | Badge = verification tier only, never plan (ADR-003, ADR-005). Show the tier ladder and what each tier unlocks. |
| Seller complaints on incumbent lead model | Fake leads, the same enquiry sold to many sellers, delayed or already-expired leads, refunds refused after "leads consumed" (5). | Landing page and lead UI say it plainly: capped exclusive leads, visible intent score and rank, credit only on accept, auto-refund within 72h with no ticket (ADR-002, ADR-005). |
| Compliance | GSTIN: 15 chars, state code + PAN + entity + Z + mod-36 checksum, so format/checksum can be checked client-side before any API call (9); a valid checksum does not prove the GSTIN is active. Consent must be itemised and purpose-specific (10). | Inline GSTIN checksum feedback, then server verification. Separate, unticked-by-default toggles for matching, counterparty sharing and marketing (ADR-010). |

## Design decisions for apps/seller

1. **Five-step resumable wizard, each step saves immediately** (ADR-003 T0/T1 fast path, ADR-004): business basics, phone OTP, GST (skippable), first listing by AI, plan + consents. Resume point is derived from server state (business exists, phone verified, listing exists), so closing the tab loses nothing.
2. **GST is skippable** with an explicit explanation: the seller stays T0, shows "Unverified", and can verify any time from /verification (ADR-003). No bank or PAN collection in Phase 1 (no payouts, ADR-001; avoids storing sensitive data, ADR-010).
3. **One listing to go live**, drafted by AI from a WhatsApp-style message (Hindi/Hinglish examples), always shown as an editable "AI draft, check before publishing" form; moderation outcome shown after publish (ADR-003, ADR-004, DESIGN principle 5).
4. **Time-to-first-listing** logged as structured timestamps (business created, listing published) per the ADR-004 median <15 minute target.
5. **Trust and money transparency** (ADR-002, ADR-005): lead cards show intent score, reasons, "Rank r of N", 2h countdown; Accept says it uses 1 credit; problem report promises the 72h auto-refund; billing shows public plans, no auto-renew language, cancel in at most 3 taps.
6. **Consents** are separate and granular, marketing opt-in unticked, all revocable from /settings (ADR-010, DPDP).
7. **Mobile first**: bottom navigation, 44px touch targets, server-rendered pages, minimal client JS (ADR-004, DESIGN).
8. **Deferred**: photo upload (image URLs only for now), voice/WhatsApp channel (needs ADR-004 platform work), T2/T3 verification, bank details, vernacular UI strings.
