# RFQ and quote attachment scanning, quarantine and retention

Status: built. Relates to ADR-010 (security and DPDP), ADR-042 (security hardening), `docs/compliance/retention-schedule.md`.

Buyers attach drawings and specs to a requirement (up to 5 files, 10 MB) and sellers attach files to a quote (up to 3, 5 MB). Other businesses download them, so they are a malware vector. Before this change they were only type-checked by magic bytes.

## Flow

1. `checkAttachments` (unchanged) validates count, size and type (PDF, JPG, PNG by magic bytes). It now also honours `RFQ_ATTACHMENTS_ENABLED=false`.
2. `storeAttachmentBytes(enquiryId, files, { actor, kind })` **scans every file first** through the `AttachmentScanner` port (`@cnote/media`, `packages/media/src/scan.ts`). Nothing is written to the bucket and no `EnquiryAttachment` row exists until every file is clean, so a file is never visible to the other party unscanned.
3. Clean: the object is written to `rfq/<enquiryId>/<id>.<ext>` and the row is created in the same transaction as the enquiry or quote, now carrying `scannedAt` and `scanner` as evidence.
4. Infected: the bytes are written to `rfq/quarantine/<enquiryId>/<id>.<ext>` (private bucket, never served by any route), an `AttachmentQuarantine` row is created and `AttachmentQuarantined` (v1) is emitted in one transaction, and the whole upload is rejected with a validation error. The enquiry or quote is not created.
5. Scanner unavailable (clamd down, timeout, protocol error, misconfiguration): **fail closed**. The upload is rejected with a retryable error ("try again in a few minutes") and nothing is stored.
6. The notification observer (`attachment.quarantined`, template in the admin template studio) tells the uploader which kind of upload was blocked. The payload and the message carry no file content.

## Adapters

| Adapter | Selected by | Behaviour |
|---|---|---|
| `mock` (default) | `ATTACHMENT_SCANNER=mock` or unset | Flags the EICAR test string anywhere in the file; everything else is clean. Dev, CI, e2e. |
| `clamav` | `ATTACHMENT_SCANNER=clamav`, `CLAMAV_HOST`, optional `CLAMAV_PORT` (3310), `CLAMAV_TIMEOUT_MS` (15000), `CLAMAV_CONNECT_TIMEOUT_MS` (3000), `CLAMAV_CHUNK_BYTES` (65536) | clamd INSTREAM over TCP: `zINSTREAM\0`, then big-endian length-prefixed chunks, then a zero length; reads the NUL-terminated `stream: OK` or `stream: <signature> FOUND`. Anything else (including `ERROR`, such as the clamd `StreamMaxLength` being exceeded) is "unavailable", never "clean". Connect timeout, overall deadline and socket errors all fail closed. |

Run clamd with `StreamMaxLength` of at least 10 MB (the largest RFQ attachment) and keep the signature database fresh (`freshclam`). One clamd per region behind a ClusterIP service is enough at Phase-1 volumes.

## Production gate

`validateSecrets` (web and seller, production only): with uploads on and no `clamav` scanner the process refuses to start, unless `ATTACHMENT_SCAN_WAIVER=1` (downgrades to a warning that says uploads are not virus-scanned). `ATTACHMENT_SCANNER=clamav` without `CLAMAV_HOST` is also an error. Uploads can be switched off with `RFQ_ATTACHMENTS_ENABLED=false`. The e2e servers and the dev k8s overlay set the waiver; staging and production must not.

## Retention (decision: 365 days)

`enquiry.attachments_after_close_365d` (compliance retention registry, env `RETENTION_ENQUIRY_ATTACHMENTS_DAYS`) deletes attachment bytes and rows 365 days after the requirement's quote deadline. `Enquiry` has no `closedAt`, and `closed` is never set by code today, so the quote deadline (`expiresAt`) is the one reliable end-of-life timestamp; legacy rows without a deadline fall back to creation date once their status is closed, rejected or unmatched. A year covers repeat orders and follow-up quotes. Requirements that became an order keep their attachments a further 730 days from the order, to match the 3-year dispute limitation window used for dispute evidence (ADR-013). `enquiry.attachment_quarantine_30d` deletes quarantined bytes after 30 days and keeps the row (who, when, signature) as the audit record.

DPDP export: the enquiry module's `exportPersonalData` lists attachment metadata (now with scan time and scanner) and a new `quarantinedAttachments` collection (metadata only, never storage keys).

## Decisions

- Scan before store, reject the whole upload on a single detection: simplest guarantee that nothing infected becomes visible, and a buyer with one bad file is more likely compromised than unlucky.
- Fail closed on scanner errors. Availability of uploads depends on clamd; the kill switch is `RFQ_ATTACHMENTS_ENABLED=false`.
- Quarantine key under `rfq/quarantine/` so no media-key change is needed and the private-only rule already applies.
- `AttachmentQuarantine.enquiryId` is not a foreign key: a blocked RFQ upload means the enquiry was never created.
- Not done: an ops screen for quarantined uploads (rows are queryable and appear in the DPDP export), re-scanning old attachments with fresh signatures, scanning other upload paths (KYC documents, dispute evidence, bulk sheets).
