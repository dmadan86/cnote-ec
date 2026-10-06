# Verification depth (ADR-003) and buyer reachability (ADR-002)

Builds on `t2-t3-verification.md` (T2 documents + video KYC, T3 audits) and `gst-verification.md` (T1 GST). This document records what was added in the trust_verif stream and the decisions behind it. Code: `packages/identity/src/registry/**`, `audit-partners.ts`, `packages/enquiry/src/{reachability,reachability-provider,risk}.ts`.

## What already existed (not duplicated)

T2 document upload with AI extraction + forensics + cross-checks, hosted-link video KYC with scores only, staff review, 90-day purge; T3 request/schedule/record/expire; a WhatsApp/SMS reachability check (seller-reported "unreachable" and 24h window) feeding the 72h refund. The assignment's `verifyDocument` capability is `ai.extractDocument` + `evaluateKycDocument` (extraction, forgery signals, consistency with declared/GST/Udyam/MCA data, confidence threshold to the staff queue). No new prompt was added, so the AI eval gate is untouched.

## 1. Udyam and MCA/CIN verification (T1 evidence)

Ports `UdyamProvider` / `McaProvider` (`registry/providers.ts`): `mock` (default, refused in production) and `surepass`. HTTP goes through `assertPublicHttpTarget` + `pinnedFetch`, 8 s timeout, 2 retries on timeout/5xx, Redis circuit breaker shared with GST. Env: `UDYAM_PROVIDER`, `MCA_PROVIDER`, `REGISTRY_PROVIDER_KEY`, `REGISTRY_PROVIDER_BASE_URL`, `REGISTRY_PROVIDER_TIMEOUT_MS`. `validateSecrets` refuses mock and a missing key.

Surepass research: public pages only ([Udyam Aadhaar verification](https://surepass.io/udyam-aadhaar-verification-api/), [MCA data APIs CIN/DIN](https://surepass.io/mca-data-apis-cin-din-v3-portal/)); request/response schemas are shared after signup. Documented response content: CIN, business name, RoC, company status (Active / Struck Off), registrar address, directors, incorporation date. Paths (`/api/v1/corporate/udyog-aadhaar`, `/api/v1/corporate/company-details`) and JSON keys follow Surepass' bearer-token convention used by its GSTIN API and are UNCONFIRMED: `parseSurepassUdyam`, `parseSurepassMca` and the two PATH constants are the only places to adjust.

Match scoring (`registry/match.ts`, `registry/verify.ts`): status 35, identifier 5, name 40 (same token-set similarity and 0.85/0.6 thresholds as GST), address 20 (pincode 0.4, state 0.2, city 0.15, street overlap 0.25). Fail: inactive, different number, name < 0.6. Review: partial name, address < 0.4, or number already verified for another business. Evidence (checks, scores, snapshot) is in `VerificationRecord.details`; review items are resolved in admin (`/businesses/registry-reviews`, `businesses.verify`, audited).

Effect (decision): GST stays the T1 gate. A pass stamps `udyamVerifiedAt` / `mcaVerifiedAt`, emits `BusinessVerified{kind:"udyam"|"mca"}` and adds +3 trust points each; a struck-off/non-active MCA record is a failed record and a -10 trust penalty until resolved. `UDYAM_GRANTS_T1=1` (default off) lets a pass grant T1 to a seller with no GSTIN (sub-threshold MSMEs); such records are marked `grantedT1` so releasing a GSTIN claim does not strip them. A 90-day re-check job (`identity.registry-recheck`) clears the stamp when a registration is cancelled. KYC document checks also accept the registry-returned names as the declared name.

## 2. T2 additions

- Document type `shop_establishment` (cancelled cheque is `bank_proof`; utility bills `address_proof`). No prompt text changed.
- IDfy `HttpKycProvider` skeleton next to HyperVerge/Signzy (`KYC_PROVIDER=idfy`, `KYC_ACCOUNT_ID`, `KYC_IDFY_CONFIG_ID`; `api-key` + `account-id` headers; Create Profile Link, status APPROVED/REJECTED; gated vendor docs, mapping UNCONFIRMED). Only liveness/face-match scores and reason codes are stored; the provider hosts capture.
- DPDP: `exportPersonalData` now includes the person's KYC sessions and masked document fields (never images, PAN ciphertext or biometrics); erasure also clears the new registry stamps. Retention is unchanged (`identity.kyc_documents_90d`).
- T2 is granted only when documents and video both pass, or staff approve (existing).

## 3. T3 partner flow

`AuditPartner` records (external agencies, not logins). Staff assign a partner to a requested/scheduled audit and issue a single-use link (32 random bytes, only the sha256 stored, 14 days, replaced on re-issue, shown once). The public page `/partner/audit/<token>` (admin app, outside the session gate, no-referrer, geolocation allowed on that path only) collects inspector, summary, checklist and 4-12 photos; location is read from the device when each batch of photos is added. `POST /api/partner-audit/<token>` uses `readBoundedFormData`, rate limits per IP and token, and stores photos in the private store.

`evaluateAuditSubmission` flags: unanswered/failed checklist items, fewer than 4 photos, duplicate photos, missing/foreign geotags, photos more than 300 m from their centroid, capture time in the future or older than 72 h. Flags are shown to staff only. The audit moves to `submitted` (`AuditSubmitted`); staff `reviewAuditSubmission` (audited, note required) records pass/conditional/fail, or send it back (photos deleted, new link needed). A pass gives Tier 3 until `validUntil`, with `reAuditDueAt` = 30 days before; the seller sees the re-audit prompt and admin lists due re-audits. The badge always derives from `verificationTier`. The checklist defaults in code and is overridable via `AUDIT_CHECKLIST_JSON` (category-specific content is config, ADR-011). Retention: photos and coordinates 365 days after decision (`identity.audit_photos_365d`).

Decision: an `audit_partner` staff role was not added; external partners never need a console login, and a signed link has a smaller blast radius.

## 4. Reachability (ADR-002)

- `ReachabilityProvider` port (`reachability-provider.ts`): `mock`, `exotel`, `knowlarity` skeletons; `REACHABILITY_IVR_PROVIDER=off` by default (links only). Exotel: [outgoing call to a call flow](https://developer.exotel.com/docs/voice-v1/api-reference/outgoing-call-to-flow) (`Calls/connect.json`, `Url` flow, `StatusCallback`, `CustomField`; the flow gathers the digit and hits our Passthru URL). Knowlarity: `makecall` with `x-api-key`; webhook mapping UNCONFIRMED.
- Callback auth (security review): the master secret never appears in a URL. HMAC header `x-reachability-signature` (`REACHABILITY_WEBHOOK_SECRET`) for vendors that sign; Exotel gets a per-check token `HMAC(REACHABILITY_URL_SECRET, "reach:"+checkId)` in `?check=&token=`, bound to that check, compared as canonical strings in constant time; the two secrets must differ; the `token` param is redacted by observability scrubbing; the webhook never logs the URL. Endpoint: `POST|GET /webhooks/reachability` on apps/api.
- Flow: after an enquiry is created, `startProactiveReachability` (`REACHABILITY_PROACTIVE=low_intent` default: intent < 60 or fake-lead risk >= 40; `all`; `off`; max 3 per buyer per day). IVR call first; no answer/busy/failed triggers the WhatsApp/SMS confirm link once (attempt 2); "press 1" = confirmed, "press 2" = not me. No answer by the 24h expiry ends as `no_response`; `sweepProactiveNoResponse` then refunds accepted leads still inside their 72h window, including leads accepted afterwards. Delivery failures on our side never refund (seller-report path keeps its older rule). Gap: a seller does not yet see "buyer check in progress" for an enquiry-level check on the lead card.
- Device signals (`risk.ts`), server-side only: `ipHash` is a keyed hash (blind index) of the /24 (IPv4) or first three hextets (IPv6), user-agent FAMILY, velocity per person (1 h, 24 h) and distinct buyers per ip-prefix (24 h). No raw IP, no device cookie or fingerprint, so the cookie-consent registry and `CONSENT_POLICY_VERSION` are unchanged. `computeFakeLeadRisk` (0-100, reasons) feeds `ai.scoreIntent` as `fakeLeadRisk`; the orchestrator subtracts up to 40 points for every provider and prepends the reason, and the input is in the AiDecision log. Retention: hash nulled after 90 days (`enquiry.fake_lead_signals_90d`); DPDP export lists the signals.
- Labels and measurement: ops label enquiries in admin `/fraud-labels` (genuine / fake / spam / unreachable, audited, emits `EnquiryLabelled`); CSV export has no free text and is formula-injection safe; metrics `fake_lead_precision` (target 90%) and `fake_lead_recall` (80%) are computed from the event log when labels exist (alerts need 30 labelled cases). "Predicted fake" = risk >= 60 or intent < 20.

## Decisions summary

No new prompt or AI capability; mock providers by default; Udyam/MCA supplementary to GST; external audit partners via signed links; proactive checks only for doubtful enquiries to bound call cost; `@cnote/enquiry` may now depend on `@cnote/security` (boundaries updated).

## Mobbin references (UI)

- [Revolut Business: Submitting proof of identity](https://mobbin.com/flows/55d0b6c4-c006-4452-823b-401ab71d1463) and [Verifying proof documents](https://mobbin.com/flows/b8e8d4a0-5171-4ede-bd48-b07209864706): per-document rows with status ("Requires action", "Verifying", "Verified"), add-document drop target with supported formats, and a "take a picture on your phone" step list before the capture. Adopted for the seller document list and the video KYC start text (already present) and the registry card's verified-on line.
- [Binance: Uploading a document](https://mobbin.com/flows/7bb0553d-5ae1-4183-bd28-4a38c23af034): preview with remove control and Continue disabled until valid. Adopted in the partner photo grid (preview, Remove, Submit disabled until the minimum is met).
- Earlier references stay in `t2-t3-verification.md`. A search for a "video verification start screen" timed out; the existing start step was left unchanged.

## Not done

Real vendor sandboxes (Surepass, IDfy, Exotel, Knowlarity) were not available: field mappings are unconfirmed and marked. No pixel-level forgery detection. The "checking" state on the seller lead card for enquiry-level checks. No Playwright specs were run (the partner page is an admin-app screen, not buyer web).
