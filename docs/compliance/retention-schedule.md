# Retention schedule

Implements ADR-010 and the storage-limitation duty of the DPDP Act 2023 (s.8(7): erase personal data when the purpose is served and retention is no longer required by law). Code: `packages/compliance/src/retention.ts`. Each policy calls a purge function exported by the owning module; every run writes a `RetentionRun` row (admin: Compliance > Retention).

Windows are env-configurable (`RETENTION_<KEY>_DAYS`); the values below are the defaults. `RETENTION_ENABLED=false` stops the job, `RETENTION_DRY_RUN=true` makes the scheduled job count without deleting. The worker ticks hourly and runs at most two due policies per tick (staggered), each at most once per ~23 hours.

| Policy | Module | Data | Default window | Env key | Legal basis / rationale |
|---|---|---|---|---|---|
| `enquiry.message_bodies_inactive_24m` | enquiry | Message bodies in conversations inactive for the window are replaced by `[deleted per retention policy]`. Metadata and domain events kept. | 730 d | `ENQUIRY_MESSAGES` | Storage limitation; limitation period for commercial disputes bounds the outer limit |
| `identity.auth_sessions_expired_90d` | identity | Revoked/expired `AuthSession` rows (IP, user agent) | 90 d | `AUTH_SESSIONS` | Storage limitation; 90 days of security context kept for incident response |
| `identity.erased_person_residuals_30d` | identity | Residual session rows of persons erased under DPDP s.12 | 30 d | `ERASED_RESIDUALS` | Right to erasure |
| `catalogue.soft_deleted_images_30d` | catalogue | Bytes and rows of listing images the seller deleted | 30 d | `DELETED_IMAGES` | Seller-initiated deletion; grace for accidental deletes |
| `catalogue.voice_notes_expired` | catalogue | Voice-note audio past `purgeAfter` (kept only with `voice_retention` consent) | per row | `VOICE_NOTES` | Purpose-scoped consent (ADR-004/010). Runs once the AI workstream exports `purgeExpiredVoiceNotes` |
| `whatsapp.message_bodies_retention` | whatsapp | WhatsApp message bodies and media keys | 30 d | `WHATSAPP_MESSAGES` | Storage limitation (ADR-004). Runs once `purgeWhatsAppMessages` is exported |
| `leadgen.abandoned_captures_90d` | leadgen | Captures that never verified (started, otp_sent, abandoned) | 90 d | `ABANDONED_CAPTURES` | Data minimisation of unconverted funnel data |
| `notifications.read_90d` | notifications | Read in-app notifications (unread kept) | 90 d | `READ_NOTIFICATIONS` | Storage limitation |
| `reviews.rejected_ugc_12m` | reviews | Rejected reviews and comments (never public) and their reactions | 365 d | `REJECTED_UGC` | Storage limitation; leaves a full year for appeals |
| `wishlist.empty_lists_24m` | wishlist | Empty, non-default wishlists | 730 d | `EMPTY_WISHLISTS` | Storage limitation |
| `identity.inactive_accounts_erasure` | compliance (via identity) | Buyer-side personal accounts with no sign-in or API-key use for the window: notice, then erasure (`erasePerson`). **Off unless `INACTIVITY_ERASURE_ENABLED=true`.** | 1095 d | `INACTIVE_ACCOUNTS` | DPDP Rules 2025 r.8 and Third Schedule (3 years for e-commerce entities above the user threshold) with a 48-hour prior notice; see below |
| `compliance.nominee_requests_decided` | compliance | Rejected / completed nominee requests (encrypted requester name, contact, message) and revoked nominations | 1095 d | `NOMINEE_REQUESTS` | Storage limitation; 3 years for a challenge to the decision, pending counsel review |
| `enquiry.attachments_after_close_365d` | enquiry | RFQ drawings/specs and quote attachments: bytes in the private bucket and the `enquiry_attachments` rows. Clock starts at the requirement's quote deadline (`expiresAt`), or for legacy rows without one, creation of a closed/rejected/unmatched requirement. Requirements that became an order keep theirs a further 730 d from the order (dispute limitation). | 365 d | `ENQUIRY_ATTACHMENTS` | Storage limitation; one year covers follow-up quotes and repeat orders |
| `enquiry.attachment_quarantine_30d` | enquiry | Bytes of uploads the malware scanner flagged; the `attachment_quarantine` row (who, when, signature, no bytes) stays as the audit record | 30 d | `ATTACHMENT_QUARANTINE` | Storage limitation; kept only for security review |

## Deliberately never purged

- **Consent ledger** (`Consent`): append-only legal record of what a person agreed to and withdrew (ADR-007/010).
- **Admin audit log** (`AdminAuditLog`) and **domain event log**: DPDP Rules 2025 require processing logs to be retained for a minimum period (reported as one year; confirm against the gazetted text). Personal data inside events is minimised at write time.
- **Listing and storefront versions**: audit history of moderation decisions (needed for appeals).
- **Erased persons' rows**: tombstoned, not deleted, for referential integrity (`erasePerson`).
- **Financial records** (credit ledger, future orders): retained per tax and accounting law.

## Processed in memory, never stored (no retention window needed)

- **Buyer voice search audio** (`POST /api/search/voice`, ADR-004/010): the recording is read into memory, sent to the speech provider (`ASR_PROVIDER`) through `@cnote/ai` `transcribe`, and dropped when the request ends. Nothing is written to disk, object storage or a table by the route; the browser releases the microphone immediately after recording and holds the clip only in a `Blob` until it is posted. The AI decision log keeps only a hash of the audio, its size and the redacted transcript text (same as every `transcribe` call). The buyer is shown a notice and must agree before the first recording (stored as the strictly necessary `cnote_voice_consent_v1` flag). Because no recording is retained there is no purge policy and no `exportPersonalData` source for it. If search audio is ever kept (for example to improve recognition), it needs its own purpose-scoped consent, a policy in this table and an export source.
- **Buyer photo search image** (`POST /api/search/image`): validated, re-encoded in memory (EXIF/GPS/ICC dropped) and discarded after the vision call; only the derived keywords are returned. Same rule: storing it would need explicit consent plus a policy here.
- **Search queries and staff judgements**: staff relevance judgements (`search_judgements`) contain staff-typed queries only, no buyer data, and are kept as evaluation evidence.
## Inactivity erasure and the 48-hour notice

DPDP Rules 2025, r.8 with the Third Schedule: certain classes of Data Fiduciary (e-commerce entities above the registered-user threshold, online gaming intermediaries, social media intermediaries) must erase a data principal's personal data when the principal has not approached the fiduciary, nor exercised their rights, for the prescribed period (3 years for e-commerce), and must inform the principal **at least 48 hours before** that period completes so they can log in or get in touch. Verify the gazetted text and whether the platform crosses the threshold before enabling (`INACTIVITY_ERASURE_ENABLED=true`).

How it runs (`packages/compliance/src/inactivity.ts`, a normal retention policy, daily tick):

1. **Candidates**: not erased, has an e-mail address (no address means no notice, so no erasure), not staff, not a member of a **seller** business (tax-invoice and trust records outrank erasure, see `erasePerson`), no live session, last activity older than window minus notice period. "Activity" is the durable `persons.last_active_at` (written at sign-in and session refresh, at most once a day; sessions themselves are purged after 90 days), the newest session, or an API key use.
2. **Notice**: an `inactivity_erasure_notices` row (`eraseAfter` = now + notice period) and an `InactivityErasureNoticeSent` event in one transaction; `@cnote/notifications` e-mails the DB template `account.inactivity_erasure_notice` (editable in the template studio). `INACTIVITY_NOTICE_HOURS` defaults to 168 (7 days) and is **clamped to at least 48**; the executor additionally refuses any notice whose `eraseAfter` is less than 48 h after `noticedAt`.
3. **Erasure**: only on a later run, after `eraseAfter`, and only if the person has not been active since the notice and is still eligible. Otherwise the notice is cancelled with the reason (`activity_since_notice`, `api_activity_since_notice`, `no_longer_eligible`, `already_erased`, `notice_period_too_short`). Coming back always wins. Erasure goes through identity's `erasePerson`, the same path as the person's own erasure (withdraws consents, revokes sessions and API keys, emits `DataErasureRequested`).
4. A dry run (admin: Compliance > Retention) reports the numbers without sending or erasing, even when the flag is off.

Known limits: activity is measured at the identity level (sign-in, API key use). A person who only ever receives e-mail from us and never signs in counts as inactive, which is the Rules' intent (they have not approached us). Notice delivery is the e-mail pipeline's: the row records that the notice was issued, not that the mailbox accepted it (bounces are in the e-mail log).

## Open items

- DPDP Rules 2025 (Third Schedule) prescribe a sector-specific retention floor for large e-commerce entities. Verify whether the platform crosses the user thresholds before shortening any window below that floor, (the 48-hour notice is implemented, see above; it is only active when the flag is on).
