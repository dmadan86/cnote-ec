# Lead generation: when and how we ask anonymous buyers for a mobile number

Status: implemented in `@cnote/leadgen`, `@cnote/identity` (phone-login), `@cnote/next-kit` (otp), `apps/web/src/features/leadgen`.
Goal: capture verified buyer leads without the aggressive gating that IndiaMART is criticised for (ADR-002, ADR-003), and without harming SEO or accessibility.

## Research summary (sources)

- **Incumbent pattern.** IndiaMART's "Get Best Price" asks for a mobile number and email and tells the buyer the seller will share details on that number ([IndiaMART help](https://help.indiamart.com/knowledge-base/why-indiamart-asks-for-number/)). The ask is tied to a concrete, high-intent action. We keep that (the ask is justified by the action) but add verification, exclusivity (ADR-002) and no selling of the number.
- **Google intrusive interstitials.** Google demotes mobile pages whose content is obscured by a pop-up right after arriving from search. Legally required dialogs (cookies, age) and login dialogs on non-indexable content are exempt; easily dismissed banners are fine ([Google Search Central](https://developers.google.com/search/docs/appearance/avoid-intrusive-interstitials)). Our product pages are public and indexable, so **nothing may open on page load**. Dialogs open only as the direct result of a user click.
- **NN/g on modals.** Modals suit information critical to continuing the current task; most overlays appear at the wrong time and interrupt ([NN/g](https://www.nngroup.com/articles/modal-nonmodal-dialog/)). Hence: a modal only after an explicit click, and passive nudges never modal.
- **Baymard on forced accounts.** Baymard's research found forced account creation makes a sizeable share of shoppers abandon; the fix is guest-first with account creation deferred ([Baymard](https://baymard.com/research-articles/make-guest-checkout-prominent)). Our analogue: browsing, search, compare and save-locally stay open; we ask only when a seller must be contacted, and a phone number alone (no password, no email) creates the account.
- **OTP channels India.** WhatsApp authentication templates have a fixed format (one OTP variable, optional expiry, copy/one-tap button, no promotional content) ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates)). A common recommendation is WhatsApp first with SMS fallback ([QuickAuth](https://quickauth.in/blog/whatsapp-otp-vs-sms-otp-india); vendor claim, not independently verified). We offer both channels and let the buyer choose; default is SMS (works without WhatsApp), remembered afterwards.
- **TRAI DLT.** Every commercial SMS to Indian numbers, OTPs included, needs a registered entity, header and template, and the template ID must be sent with each message or the operator scrubs it ([WebEngage DLT guide](https://docs.webengage.com/docs/trai-sms-dlt-regulations-india); [Exotel](https://support.exotel.com/support/solutions/articles/3000096504-trai-regulations-on-commercial-communications-dlt-portal-sms-in-india)). The `OtpSender` adapters must carry a `templateId`. Action item for ops: register the OTP template before launch.
- **DPDP.** Notice before collection, itemised data and purpose, consent free, specific, unbundled, no pre-ticked boxes, and withdrawal as easy as giving ([DPDP Rules 2025, PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf); [Inamdar Legal](https://inamdarlegal.com/resources/consent-notices-dpdp-rules-2025-requirements)). Hence separate unticked checkboxes; only the purpose "share my requirement with matched sellers" is required for the action itself (ADR-010 `matching`), follow-up and marketing are optional and separate.

## Decisions

### Triggers
High-intent (open the unlock dialog immediately on click; anonymous users only):
1. `pdp_best_price` "Get best price" -> unlock `enquiry` (creates an enquiry with `preferredListingId`)
2. `pdp_contact_seller` "Contact seller" -> unlock `seller_contact` (see below)
3. `request_quote` "Request quote" -> unlock `quotes`
4. `catalogue_download`, `compare_limit` (saving/comparing beyond N=3 items anonymously) -> unlock `save` / `catalogue`

Soft nudges (never a modal; a dismissible inline banner, `role="region"`, not focus-stealing):
- 4th distinct product view in a session, or a return visit (2nd session within 7 days) -> "Get prices from verified suppliers" banner opening the dialog on click.
- Exit intent: desktop only (mouse leaving through the top of the viewport), only after >= 2 product views, never on mobile, never on the landing page of a search visit. Rendered as the same inline banner, not a modal.
Never: on page load, on first pageview of a session, on search landing, over the header/footer, on checkout-like flows.

### Frequency caps (localStorage, per browser)
- High-intent triggers are user-initiated, so uncapped.
- Soft nudges: max 1 per visitor per day, max 3 per week; after dismiss, 7-day cooldown for that trigger; after 2 dismissals, 30 days; after a successful verify or an "already signed in" state, never.
- Server enforces OTP limits regardless (per phone, IP, visitor).

### Copy
Say what happens and what we do not do: "Get the best price from verified suppliers. Enter your mobile number to verify it is you. We share your requirement with up to 3 matched suppliers, not everyone." Buttons: "Send code on SMS" / "Send code on WhatsApp". No urgency tricks, no pre-checked consents.

### What unlocks
- Verified phone = T0 buyer (ADR-003). Unlocks: enquiry creation (matched to <= 3 sellers, ADR-002), quote requests, saving to account.
- **Seller phone is never revealed to unverified users** (ADR-002). "Contact seller" for a verified buyer creates an enquiry with the seller as preferred, and the seller replies via in-app conversation; seller contact details are released only by the enquiry accepted-match rules, not by the unlock.

### Progressive profiling
After verification: ask only for what the action needs (product, quantity, city/pincode). Name, business name, GSTIN, email are asked later, on the result page or the next visit, each optional, never blocking the unlock.

### Abandonment follow-up
A capture with no verification after 30 minutes is marked `abandoned`. A follow-up (single WhatsApp/SMS reminder) may be queued **only** if the buyer ticked the separate "You may contact me about this requirement if I do not finish" box; this phase only emits/logs the intent, no sending. Phone is stored hashed only on the capture; raw phone exists only on `Person` after verification, so an unverified follow-up has no number to send to. This is a deliberate DPDP minimisation: follow-up therefore requires the buyer to have verified, or a later consented plaintext channel (out of scope, documented gap).

### Metrics
Funnel by trigger/day: started -> otp_sent -> verified -> converted; abandonment rate; dismiss rate of soft nudges. Admin page `/leadgen` (privilege `leadgen.read`), counts only.

## Accessibility
Native `<dialog>` via `showModal()` (focus trap, Esc, inert background), labelled title, focus returns to trigger, errors in `aria-live="polite"`, OTP field `autocomplete="one-time-code"` `inputmode="numeric"`, 44px targets, resend timer announced not per-second.
