# WhatsApp channel and OTP delivery

Implements ADR-004 (WhatsApp-native seller onboarding), ADR-002 (reachability), ADR-010 (purpose-scoped consent). Code: `packages/whatsapp`, `packages/identity/src/otp-senders.ts`, `apps/api/src/routes/webhooks/whatsapp.ts`, `apps/admin/src/app/(console)/whatsapp`.

## Research summary (WhatsApp Cloud API, Graph API v2x)

- **Webhook verification.** Meta calls `GET <callback>?hub.mode=subscribe&hub.verify_token=<ours>&hub.challenge=<n>`; we echo `hub.challenge` (200) only when the token matches. ([Webhooks: create an endpoint](https://developers.facebook.com/docs/graph-api/webhooks/getting-started))
- **Signature.** Every POST carries `X-Hub-Signature-256: sha256=<HMAC-SHA256(app secret, raw body)>`. Validate over the untouched bytes, constant-time. ([Webhooks: payload validation](https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications))
- **Payloads.** `object: whatsapp_business_account`, `entry[].changes[].value` holds `contacts[]`, `messages[]` (types `text`, `image`, `audio` (voice notes have `voice: true`), `interactive` with `button_reply`/`list_reply`, template `button`, plus stickers/video/documents) and `statuses[]` (`sent`, `delivered`, `read`, `failed` with `errors[]`). ([Payload examples](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples))
- **Media.** Inbound carries a media id. `GET /{version}/{media-id}` returns a short-lived `url`; `GET url` must send the bearer token. Size cap in our adapter: 16 MB. ([Media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media))
- **Sending.** `POST /{version}/{phone-number-id}/messages` with `type` text | template | interactive (`button` max 3 buttons, title 20 chars; `list` max 10 rows, title 24). Mark as read: `{status:"read", message_id}`. ([Messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages))
- **24-hour customer service window.** Free-form messages are allowed for 24 h after the user's last message; outside it only approved templates (error 131047 otherwise). Templates have categories authentication, utility, marketing. ([Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), [Templates](https://developers.facebook.com/docs/whatsapp/message-templates))
- **Authentication templates.** Fixed format: one body variable (the code), optional expiry line, a "Copy code" (one-tap/copy) button, no links or promo text. The send payload repeats the code as the button's `url` parameter. ([Authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates))
- **Pricing (India, verify before launch; rates change quarterly).** Per delivered template message: marketing about Rs 0.86 to 1.09, utility and authentication about Rs 0.115 to 0.145, plus 18% GST. Utility templates sent inside an open window are free; service (free-form) replies were free, with a per-number free tier announced from 1 Oct 2026 (search results, [Meta pricing page](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), [AiSensy India rates](https://aisensy.com/pricing)). We record an estimate in `WhatsAppMessage.costPaise` (`TEMPLATE_COST_PAISE`: auth 12, utility 12, marketing 87 paise) and treat window replies as 0.
- **MSG91 SMS OTP.** `POST https://control.msg91.com/api/v5/otp?template_id=<id>&mobile=91XXXXXXXXXX&otp=<code>&otp_expiry=10` with header `authkey`. `template_id` is mandatory and must map to a TRAI DLT-approved template (entity id, 6-char header/sender id, template text with `{#var#}`); message text must match the DLT text exactly. Some rejections return HTTP 200 with `{type:"error"}`. ([MSG91 SendOTP setup](https://msg91.com/help/sendotp/where-to-find-the-sendotp-api-how-to-get-template-id), [DLT checklist](https://msg91.com/help/dlt-registration-in-india/dlt-debugging-checklist))
- MSG91 and Gupshup also resell the WhatsApp Cloud API. We call Meta directly (fewer moving parts); a provider adapter can be added behind `WhatsAppProvider`.

## Architecture

```
Meta -> POST /webhooks/whatsapp (apps/api)
        rate limit by IP -> HMAC on raw bytes -> parse -> enqueue "whatsapp.inbound" (dedupeKey = wamid) -> 200
worker -> handleInboundJob
        status: monotonic update of WhatsAppMessage.status
        message: lock per contact -> insert WhatsAppMessage(providerId=wamid) (unique = idempotent)
                 -> extend 24h window -> STOP/START -> state machine -> effects (reply / provision / draft / submit)
```

- **Provider port** `WhatsAppProvider` (`sendText`, `sendTemplate`, `sendInteractive`, `downloadMedia`, `markRead`). Adapters `meta_cloud`, `mock` (records sends; console log in dev). `WHATSAPP_PROVIDER` defaults to meta_cloud when `WHATSAPP_ACCESS_TOKEN` is set, else mock.
- **State machine** (`machine.ts`) is a pure `(state, input, now) -> (state, effects)`; states language, consent, business_name, location, media, collecting, processing, review, done, declined. Invariants (property-tested): provision/draft/submit effects only occur after consent, and no post-consent step is reachable without `data.consent`. `coerceState` repairs corrupt JSON and never trusts a post-consent step without consent.
- **Consent (ADR-010, DPDP).** The first message is bilingual and only offers a language. The second explains what is stored and why and asks Agree/No via buttons. Before consent only a contact row (phone hash, language, state) exists; inbound text is not stored. On agreement and once a Person exists, `identity.setConsent(personId, "matching", true, "whatsapp_onboarding")` is written. Voice notes are transcribed then discarded (no `voice_retention` is requested here). STOP withdraws `marketing`.
- **Phone verification.** The WhatsApp number is verified by Meta, so it is treated as phone-verified (T0, ADR-003) via `identity.findOrCreatePersonByVerifiedPhone` (added; no session issued). The raw number is transient (job payload, then Person); `WhatsAppContact` keeps only `phoneHash` (same hash as lead-gen).
- **Media to listing.** Images (max 5) and one voice note collected, "Done" triggers `catalogue` drafting, summary with [Looks good] [Edit on web] (`SELLER_APP_URL/listings/<id>/edit`), submit calls `submitListingVersion`. Moderation still applies; nothing goes live from WhatsApp.
- **Copy** lives in DB templates: keys `whatsapp.<step>` (channel `whatsapp`, defined in `copy.ts`, English defaults via `defineTemplates`). Hindi in-code defaults (`HI_DEFAULTS`) are used when no Hindi row exists; other languages fall back to English until staff add rows in the template studio. Button titles are localized in code (en, hi).
- **Resume.** More than 6 h idle prefixes a "welcome back"; a stuck `processing` state (>10 min) reopens media collection; "help", "restart" (keeps consent and business) work everywhere.
- **Outbound helper** `sendToPhone({phone, text?, interactive?, template?, marketingConsent?})`: never messages opted-out contacts; text inside the window, else the approved template; marketing templates require consent. Returns a typed reason when not sent.
- **Retention.** `purgeWhatsAppMessages(before = now-30d)` nulls `body` and `mediaKey` (worker runs it daily; the compliance agent may call it too). We store no media; catalogue owns any retained image.

## Environment

| Var | Purpose |
|---|---|
| `WHATSAPP_PROVIDER` | `meta_cloud` or `mock` |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (system-user token), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION` (default v23.0), `WHATSAPP_GRAPH_URL` | Cloud API |
| `SELLER_APP_URL` | deep links in replies |
| `OTP_SENDER` | `console` (default), `msg91`, `whatsapp_cloud`, `whatsapp_then_sms` |
| `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_SENDER_ID`, `MSG91_BASE_URL` | SMS OTP |
| `WHATSAPP_OTP_TEMPLATE` (default `cnote_login_code`), `WHATSAPP_OTP_TEMPLATE_LANG` (default `en`) | OTP template |

Unsigned webhooks are rejected (fail closed) when `WHATSAPP_APP_SECRET` is missing; dev uses the mock provider and calls `processInboundMessage` directly.

## Templates to register

**With Meta (WhatsApp Manager)**
1. `cnote_login_code`, category AUTHENTICATION, languages en, hi: body "{{1}} is your verification code." with expiry and a Copy code button.
2. `cnote_lead_alert`, UTILITY (for lead notifications outside the window; one variable, e.g. buyer city or product), en, hi.
3. `cnote_onboarding_resume`, UTILITY: "Hi, you started listing your products on cnote. Reply to continue." en, hi (for a future nudge; see gaps).
4. Marketing templates only after a marketing consent flow exists.

**In the admin template studio** (keys, channel `whatsapp`): `whatsapp.greet`, `language_more`, `consent`, `consent_declined`, `ask_business_name`, `ask_location`, `invalid_location`, `invalid_name`, `ask_media`, `got_media`, `nudge_media`, `processing`, `draft_summary`, `submitted`, `edit_link`, `review_prompt`, `media_failed`, `submit_failed`, `provision_failed`, `processing_wait`, `done_again`, `resume`, `help`, `restarted`, `unsupported`, `opted_out`, `opted_in`. Run `seedDefaultTemplates()` for English; create `hi` rows from `HI_DEFAULTS`.

**TRAI DLT (SMS).** Register the entity, a 6-letter header, and an OTP template on the operator DLT portal (e.g. "{#var#} is your cnote verification code. It is valid for 10 minutes. Do not share it."), add the resulting DLT template id to the MSG91 template, and set `MSG91_OTP_TEMPLATE_ID`. Text must match exactly or delivery silently fails.

## Costs and failure modes

- An onboarding conversation is user-initiated, so replies are service messages (free-form, inside the window). Cost appears only for templates and OTPs.
- Provider send errors are retried inline (3 attempts); if still failing the row is stored `failed` and the flow continues (the seller re-prompts by typing). Permanent 4xx (e.g. 131047) is not retried.
- Processing errors (DB, catalogue) fail the job; the queue retries with backoff and dead-letters after 5; ops retry from admin. The inbound row is removed on failure so the retry is not seen as a duplicate.
- Concurrent messages from one contact are serialised with a Redis lock (busy jobs retry).
- Meta redelivers webhooks for days: dedupe is by queue `dedupeKey` (24 h) and by the unique `wamid`.
- WhatsApp OTP: `whatsapp_then_sms` falls back to MSG91 on any WhatsApp failure; SMS-only requests skip WhatsApp. Send errors carry `permanent` (4xx) vs retryable (429/5xx, retried with backoff, 8 s timeout). Logs mask numbers and never contain the code; an Idempotency-Key header and an in-process 60 s duplicate guard avoid double sends on retries.

## Known gaps

- The number is not stored on `WhatsAppContact`, so proactive nudges to unfinished onboardings and admin "resend" of a failed reply are not possible without an identity lookup by personId; admin offers reset and dead-letter retry instead.
- A person who already owns a business gets a second one if they onboard via WhatsApp (identity has no "list my businesses" for this flow).
- Catalogue drafting functions (`createVoiceNote`, `draftListingFromPhotos`, `draftListingFromVoice`) are called through a port with assumed signatures (see `ports.ts`).
- Only English and Hindi button labels; other languages get English copy until templates are added.
