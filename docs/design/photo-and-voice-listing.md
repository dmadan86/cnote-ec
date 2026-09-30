# Listing from photos and voice (ADR-004, ADR-008)

Two new typed AI capabilities and two catalogue entry points. Both end in an editable, `aiGenerated` **draft**; nothing is published, and photos stay `pending`/`flagged` until staff approve them.

## Capabilities (`@cnote/ai`)

| Capability | Input | Output | Review threshold |
|---|---|---|---|
| `extractListingFromImages` | 1-4 `{bytes, mimeType(jpeg/png/webp), width?, height?}`, `hintText?`, `language`, `categories` | `ExtractListingOutput` + `visualAttributes` + `detected{productType, quantityVisible}` | `extract_image` 0.6 |
| `transcribe` | `{audio{bytes, mimeType}, languageHint?}` | `{text, language, confidence, durationMs, segments?}` | `transcribe` 0.6 (empty transcript always reviewed) |

Both go through `runLogged`: an `AiDecision` row, and a `ReviewItem` on low confidence. Subject type `voice_note` was added for transcripts.

**Images.** The caller validates and re-encodes (strips EXIF/GPS/ICC, long edge <= 1568 px). The capability re-checks: type by magic bytes, count, and it *rejects* JPEG APP1 / PNG eXIf / WebP EXIF still present. The audit log stores `sha256`, size, mime, dimensions and the redacted hint, never pixels. Providers: `anthropic` (Claude vision, base64 image blocks, `output_config.format` JSON schema, 25 s timeout, falls back to the heuristic on any failure) and `heuristic` (no vision: hint text only, confidence capped at 0.3, so always `needsReview`).

**Speech.** Port `SpeechToText` (`ASR_PROVIDER=sarvam|mock`, default `mock`). Accepted: ogg/opus, mp3, m4a/aac, wav, webm; <= 10 MB, <= 5 min. Provider errors propagate (the queue retries), they are not silently replaced by an empty transcript. The logged decision holds a PII-redacted transcript.
- `sarvam`: `POST https://api.sarvam.ai/speech-to-text`, header `api-subscription-key`, multipart `file`, `language_code` (BCP-47 or `unknown`), `mode=transcribe`, `with_timestamps=true`, optional `model` (`SARVAM_STT_MODEL`). 30 s timeout, 2 retries with backoff on network/429/5xx. Sarvam returns no transcript confidence, so `language_probability` (capped 0.9, default 0.7) is used.
- `mock`: audio bytes starting `CNOTE-MOCK-TRANSCRIPT:<text>` transcribe to `<text>` (confidence 0.9); anything else gives `""`, confidence 0, review.

Env: `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ASR_PROVIDER`, `SARVAM_API_KEY`, `SARVAM_STT_MODEL` (optional).

## Catalogue

- `draftListingFromPhotos(sellerBusinessId, personId, {files, hintText?, language})`: validate each file (`@cnote/media`), `processImage` (metadata-free JPEG at the AI size and the storage size), vision extraction, draft listing, then `uploadListingImage` per photo (dedupe, prescreen, rate limit, staff approval unchanged). Duplicates or failed attachments are returned in `skipped`. 20 drafts/hour/person.
- `createVoiceNote` / `transcribeVoiceNote` / `draftListingFromVoice` / `getVoiceNote` / `purgeExpiredVoiceNotes(now, {dryRun?})` in `voice.ts`. Consent snapshot at creation (`voice_retention` -> `retainAudio`; `purgeAfter` +180 d, else +24 h). Without consent the audio is deleted right after transcription. `VoiceNoteTranscribed` is emitted once per note. Async path: queue topic `catalogue.transcribe` (`createVoiceNote(..., {queue: true})`), consumer registered in the catalogue worker.

## Seller app

`features/ai-draft/*` adds "Create from photos" (camera capture and gallery, previews, 1-4) and "Describe by voice" (MediaRecorder with timer, permission error messages, listen-back, upload fallback) to `/listings/new` and onboarding step 4. Routes: `POST /api/ai-draft/photos` (multipart, <= 21 MB) and `POST /api/ai-draft/voice` (raw audio, <= 10 MB). `proxy.ts` now sends `Permissions-Policy: microphone=(self)` on those two paths only.

## Known gaps

- Media key rules have no audio types, so audio is stored at `bulk/_voice/<id>.zip` (`application/zip`, private-only) until `KEY_MIME` gains audio entries; `voiceStorage()` switches to `listings/_voice/<id>.<ext>` automatically once it does.
- Sarvam's synchronous REST endpoint is meant for clips under ~30 s; longer notes need their batch API (not implemented). The UI nudges to ~30 s.
- Live vision/ASR evals need keys and real recordings under `packages/ai/evals/audio`.
- Transcripts persist after audio purge (only audio is purged); retention of transcripts is a compliance decision.
