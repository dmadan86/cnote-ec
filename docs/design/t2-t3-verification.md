# T2 / T3 verification: document + video KYC and partner audits

Per ADR-003: T2 = document + image forensics + video KYC; T3 = physical / third-party audit; trust is continuous. We are **not** an RBI-regulated entity: this is business verification of the authorised signatory, not V-CIP.

## Flow (T2)

1. `startKyc(actor)`: owner only, needs T1 (GST verified), one active session (7-day TTL).
2. `uploadKycDocument`: images only (JPEG/PNG/WebP, 5 MB; PDFs are not accepted: no server-side rasteriser, sellers photograph page 1). Steps: media image validation, sha256, private store, `ai.extractDocument` (vision, AiDecision logged with no bytes and redacted output), classical checks, cross-checks, verdict per document. A second upload of the same type replaces the first.
3. `beginVideoKyc`: needs GST certificate + PAN card, none failed. Creates a provider session (hosted link, full-page redirect, no iframe/SDK), emits `KycSubmitted`. The mock provider is `instant` and completes inline.
4. `completeKyc(sessionId)` (webhook or poll; verdict always re-fetched from the provider): documents + liveness/face-match -> `approved` (all pass, liveness >= 0.80, face match >= 0.75) | `review` (any document in review, or scores under threshold) | `rejected` (provider failed, any document failed, required document missing).
5. Approved: `verificationTier >= 2`, `VerificationRecord` kinds `document` + `video_kyc`, `KycDecided` + `BusinessVerified{kind:"kyc"}`, trust recomputed. Review: staff `decideKyc` (audited as `kyc.review`, note required).

## Checks per document

| Check | Fail / review |
|---|---|
| Duplicate sha256 across other businesses | fail |
| GSTIN on certificate != business GSTIN | fail |
| PAN on certificate != GSTIN chars 3-12; PAN card != declared PAN / GSTIN-derived PAN | fail |
| Udyam number != declared | fail |
| Name fuzzy match (reuses the GST `nameSimilarity`): < 0.6 on GST certificate | fail; other docs and 0.6-0.85 | review |
| AI forgery signals (fonts, pasted fields, screen photo, missing QR) | review |
| EXIF/XMP/PNG metadata naming editing software (Photoshop, GIMP, Canva, Photopea, AI generators) | review |
| Low resolution, screenshot dimensions, odd aspect ratio | review |
| AI confidence < 0.75 or unreadable required field (heuristic provider always) | review |

Known gap: no pixel-level ELA / copy-move detection; the vision model plus metadata are the only tamper signals.

## Data handling (DPDP)

- Document images live only in the **private** media bucket (currently `bulk/kyc/<business>/<session>/<doc>.<ext>`; a dedicated private-only `kyc/` prefix is requested). Staff read them through `/media/kyc/[id]` (kyc.review, `no-store`).
- PAN is stored masked (`XXXXX1234F`) plus an envelope-encrypted copy (`encryptField`, AAD `kyc.doc:<id>`); the encrypted copy is dropped at purge. Aadhaar and bank numbers: only the last 4 digits are ever requested from the model or stored.
- **Retention:** `purgeKycDocuments(before)` deletes images and encrypted PAN of sessions decided (or expired) before `before`; the compliance module calls it with `now - KYC_RETENTION_DAYS` (90). Masked fields, verdicts and check results stay as the audit record.
- **No raw biometrics:** the provider hosts capture; we receive only liveness/face-match scores and reason codes. Face images/video/templates are never requested or stored. DPDP Act 2023 has no separate biometric category, but purpose limitation, minimisation, storage limitation (Rule 8 erasure when the purpose is served) and security safeguards all apply; consent is taken at the "Start KYC" step (purpose: business verification).
- AI decision logs hold sha256 + size only, and the output has PAN/GSTIN/name/address redacted.

## Providers

`KycProvider` port: `createSession`, `getResult`, `verifyWebhook` (HMAC-SHA256 of the raw body, header `x-kyc-signature`, secret `KYC_WEBHOOK_SECRET`). Adapters: `mock` (dev/tests, refused in production), `hyperverge` and `signzy` (fetch skeletons in `kyc-provider.ts`; the vendor field mapping is at the top and **must be checked against each vendor's sandbox before go-live**). Env: `KYC_PROVIDER`, `KYC_API_KEY`, `KYC_BASE_URL`, `KYC_WEBHOOK_SECRET`. Webhook: `POST /webhooks/kyc` on apps/api.

Vendor landscape (high level): HyperVerge (OCR, face match, passive liveness, workflow/link KYC), Signzy (Video KYC API with face match and liveness), IDfy (OCR + video KYC), Digio (Aadhaar eKYC + eSign). All expose REST + hosted-link journeys with callbacks. IDfy and Digio adapters are not written yet.

## T3 audits

`requestAudit` (needs T2, one open audit) -> `scheduleAudit` -> `recordAuditResult` (`pass` -> tier 3, `VerificationRecord(audit)`, `AuditCompleted`; `fail`/`conditional` leave the tier). Report bytes go to the private store. `expireAudits` (daily job `auditWorkerJobs`): a passing audit past `validUntil` drops the tier to 2 (unless another valid pass exists) and recomputes trust. All staff mutations use `audited(ctx, "audits.manage", ...)`.

## Sources

- RBI KYC Master Direction incl. V-CIP (live officer, liveness, face match against OVD, geo-tagging, encrypted recording): summaries at [HyperVerge](https://hyperverge.co/blog/rbi-video-kyc-guidelines/), [IDfy](https://www.idfy.com/blog/rbis-direction-on-v-cip-video-kyc/), [TaxGuru](https://taxguru.in/rbi/rbi-relaxes-video-based-customer-identification-kyc-process.html). We borrow the concepts (liveness, face match, scores + audit trail, maker-checker via staff review), not the regulated process.
- DPDP Act 2023 / Rules 2025: [Rule 8 (erasure)](https://www.dpdpa.com/dpdparules/rule8.html), [Scrut guide](https://www.scrut.io/post/dpdp-rules), [India Briefing](https://www.india-briefing.com/news/dpdp-rules-2025-india-data-protection-law-compliance-40769.html/).
- Providers: [Signzy Video KYC API](https://www.signzy.com/fintech-apis/video-kyc), [HyperVerge facial recognition / liveness](https://hyperverge.co/in/integrations-marketplace/facial-recognition-api/), [provider comparison](https://gridlines.io/blogs/top-11-kyc-api-providers-in-india/).

## Mobbin references (UI)

Adapted to `@cnote/ui` tokens; no branding copied.

- [Revolut Business: Verifying personal identity](https://mobbin.com/flows/f37fbbc4-ddc2-412b-a6fe-b87d8ddc66ef): checklist of tasks with "Submitted" / "Requires action" labels and a "how to take a good photo, blurry or glare won't be approved" hint. Adopted: per-document rows with a status badge and guidance text.
- [Airwallex: Verifying ID](https://mobbin.com/flows/4ddfb2ef-818d-416c-b963-1dedf5c91aa9): document card with file name, View/Remove, upload progress bar and supported-file hint; per-person status pills ("Electronically verified", "Submitted"). Adopted: progress bar, supported formats line, replace action, verdict pills.
- [Binance: Uploading a document](https://mobbin.com/flows/7bb0553d-5ae1-4183-bd28-4a38c23af034): one clear upload target per side with a preview and a disabled Continue until valid. Adopted: Start video KYC stays disabled until required documents pass, with the reason shown.
- [Shopify: payments verification review](https://mobbin.com/screens/52ce823d-97a9-44ec-96c9-2cd9a0bf4e35): review card with masked values and "Ready to submit" status. Adopted for the staff view: masked PAN, status badge per card.
- [AirOps: review table with Decline all / Accept all](https://mobbin.com/screens/6642909e-6268-45ee-8028-72f19c646023): reasoning column next to accept/decline. Adopted: signals list beside the decision (no bulk approve: KYC is per business).
- Admin comparison uses a three-column Field / On document / Declared table beside the document image (no close Mobbin match for "extracted vs declared"; this follows the two-pane pattern of the existing image moderation page).
