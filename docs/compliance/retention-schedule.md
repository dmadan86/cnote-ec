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

## Deliberately never purged

- **Consent ledger** (`Consent`): append-only legal record of what a person agreed to and withdrew (ADR-007/010).
- **Admin audit log** (`AdminAuditLog`) and **domain event log**: DPDP Rules 2025 require processing logs to be retained for a minimum period (reported as one year; confirm against the gazetted text). Personal data inside events is minimised at write time.
- **Listing and storefront versions**: audit history of moderation decisions (needed for appeals).
- **Erased persons' rows**: tombstoned, not deleted, for referential integrity (`erasePerson`).
- **Financial records** (credit ledger, future orders): retained per tax and accounting law.

## Open items

- DPDP Rules 2025 (Third Schedule) prescribe a sector-specific retention floor for large e-commerce entities. Verify whether the platform crosses the user thresholds before shortening any window below that floor, and give the data principal at least 48 hours' notice before erasure where the Rules require it.
- Erasure notices to data principals are not yet sent before scheduled purges (only inactive-account purges would need them).
