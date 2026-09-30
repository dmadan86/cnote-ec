// Seller voice notes → transcript → editable AI draft (ADR-004). Audio is personal data (ADR-010): it lives only in the
// PRIVATE media store, is kept beyond transcription only with the `voice_retention` consent (snapshotted per note), and
// is purged by `purgeExpiredVoiceNotes` (called by the compliance retention job).
import { randomUUID } from "node:crypto";
import * as ai from "@cnote/ai";
import { DomainError, emit, getJobQueue, rateLimit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { hasConsent } from "@cnote/identity";
import { KEY_MIME, getMediaStore } from "@cnote/media";
import { draftListingFromText, getListing } from "./listings";
import { LANGS } from "./validate";
import { isUuid } from "./mappers";
import type { ListingView } from "./index";

declare module "@cnote/core" {
  interface JobTopics {
    /** Transcribe a stored VoiceNote (idempotent; retried by the queue on provider failure). */
    "catalogue.transcribe": { voiceNoteId: string; language?: string };
  }
}

export const VOICE_NOTES_PER_HOUR = 30;
export const PURGE_WITHOUT_CONSENT_MS = 24 * 60 * 60 * 1000;
export const PURGE_WITH_CONSENT_MS = 180 * 24 * 60 * 60 * 1000;

export interface VoiceNoteView {
  id: string;
  transcript: string | null;
  language: string | null;
  confidence: number | null;
  durationMs: number | null;
  listingId: string | null;
  retainAudio: boolean;
  hasAudio: boolean;
  purgeAfter: string;
  createdAt: string;
}

type Row = Prisma.VoiceNoteGetPayload<object>;
const view = (r: Row): VoiceNoteView => ({
  id: r.id, transcript: r.transcript, language: r.language, confidence: r.transcriptConfidence, durationMs: r.durationMs,
  listingId: r.listingId, retainAudio: r.retainAudio, hasAudio: r.storageKey !== null, purgeAfter: r.purgeAfter.toISOString(), createdAt: r.createdAt.toISOString(),
});

/**
 * Private-bucket key for a voice note. `listings/_voice/` keys are private-only in @cnote/media (voice is personal data);
 * the content type is media's canonical type for the extension.
 */
export function voiceStorage(id: string, mime: string): { key: string; contentType: string } {
  const ext = ai.AUDIO_EXT[mime]!;
  return { key: `listings/_voice/${id}.${ext}`, contentType: KEY_MIME[ext]! };
}

async function load(id: string): Promise<Row> {
  const r = isUuid(id) ? await prisma.voiceNote.findUnique({ where: { id } }) : null;
  if (!r) throw new DomainError("not_found", "Voice note not found");
  return r;
}
async function loadOwned(sellerBusinessId: string, id: string): Promise<Row> {
  const r = await load(id);
  if (r.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your voice note");
  return r;
}

export async function getVoiceNote(sellerBusinessId: string, id: string): Promise<VoiceNoteView> {
  return view(await loadOwned(sellerBusinessId, id));
}

/** Validates, stores the audio privately, snapshots the retention consent. `queue: true` enqueues async transcription. */
export async function createVoiceNote(
  sellerBusinessId: string,
  personId: string,
  input: { bytes: Uint8Array; mimeType: string },
  opts: { queue?: boolean; language?: string } = {},
): Promise<VoiceNoteView> {
  const mime = ai.assertAudio(input); // DomainError(validation) on type / size / empty
  if (!(await rateLimit(`voice-note:${personId}`, VOICE_NOTES_PER_HOUR, 3600))) throw new DomainError("rate_limited", "Too many voice notes. Please try again in a while.");
  const retainAudio = await hasConsent(personId, "voice_retention");
  const id = randomUUID();
  const { key, contentType } = voiceStorage(id, mime);
  const store = getMediaStore();
  await store.put(key, input.bytes, contentType);
  try {
    const row = await prisma.voiceNote.create({
      data: {
        id, sellerBusinessId, personId, storageKey: key, mimeType: mime, retainAudio,
        language: opts.language ?? null,
        purgeAfter: new Date(Date.now() + (retainAudio ? PURGE_WITH_CONSENT_MS : PURGE_WITHOUT_CONSENT_MS)),
      },
    });
    if (opts.queue) await getJobQueue().enqueue("catalogue.transcribe", { voiceNoteId: id, language: opts.language }, { dedupeKey: `transcribe:${id}` });
    return view(row);
  } catch (e) {
    await store.delete(key).catch(() => undefined);
    throw e;
  }
}

/** Idempotent: an already transcribed note is returned as is. Provider errors propagate so the queue retries. */
export async function transcribeVoiceNote(id: string, opts: { language?: string } = {}): Promise<VoiceNoteView> {
  const note = await load(id);
  if (note.transcript !== null) return view(note);
  if (!note.storageKey) throw new DomainError("conflict", "The recording has already been deleted");
  const store = getMediaStore();
  const audio = await store.get(note.storageKey);
  if (!audio) throw new DomainError("conflict", "The recording is no longer available");
  const hint = opts.language ?? note.language ?? undefined;
  const t = await ai.transcribe(
    { audio: { bytes: audio.bytes, mimeType: note.mimeType }, languageHint: (LANGS as readonly string[]).includes(hint ?? "") ? (hint as ai.Lang) : undefined },
    { type: "voice_note", id },
  );
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.voiceNote.update({
      where: { id },
      data: { transcript: t.text, language: t.language, transcriptConfidence: t.confidence, durationMs: t.durationMs || null },
    });
    await emit(tx, "VoiceNoteTranscribed", { type: "voice_note", id }, { voiceNoteId: id, sellerBusinessId: note.sellerBusinessId, listingId: null, language: t.language });
    return updated;
  });
  // Without the retention consent the audio has served its purpose: delete it now, the purge date is only the backstop.
  if (!row.retainAudio) return view(await dropAudio(row));
  return view(row);
}

async function dropAudio(row: Row): Promise<Row> {
  if (!row.storageKey) return row;
  await getMediaStore().delete(row.storageKey);
  return prisma.voiceNote.update({ where: { id: row.id }, data: { storageKey: null } });
}

/** Transcript → the existing text draft path; links the draft to the note. Idempotent per note. */
export async function draftListingFromVoice(
  sellerBusinessId: string,
  _personId: string,
  voiceNoteId: string,
  language: string,
): Promise<{ listing: ListingView; voiceNote: VoiceNoteView; transcript: string; confidence: number | null }> {
  let note = await loadOwned(sellerBusinessId, voiceNoteId);
  if (note.transcript === null) {
    await transcribeVoiceNote(voiceNoteId, { language });
    note = await loadOwned(sellerBusinessId, voiceNoteId);
  }
  const transcript = (note.transcript ?? "").trim();
  if (!transcript) throw new DomainError("validation", "We could not hear anything in that recording. Please try again, closer to the microphone.");
  if (note.listingId) {
    const existing = await getListing(note.listingId);
    if (existing) return { listing: existing, voiceNote: view(note), transcript, confidence: note.transcriptConfidence };
  }
  const listing = await draftListingFromText(sellerBusinessId, transcript, language);
  const linked = await prisma.voiceNote.update({ where: { id: note.id }, data: { listingId: listing.id } });
  return { listing, voiceNote: view(linked), transcript, confidence: linked.transcriptConfidence };
}

/** Retention hook (compliance job): deletes audio whose purgeAfter has passed and clears the key. Transcripts stay. */
export async function purgeExpiredVoiceNotes(now = new Date(), opts: { dryRun?: boolean; batch?: number } = {}): Promise<number> {
  const where = { purgeAfter: { lte: now }, storageKey: { not: null } };
  if (opts.dryRun) return prisma.voiceNote.count({ where });
  let total = 0;
  for (;;) {
    const rows = await prisma.voiceNote.findMany({ where, take: opts.batch ?? 200, orderBy: { purgeAfter: "asc" } });
    let n = 0;
    for (const r of rows) {
      try {
        await dropAudio(r);
        n++;
      } catch (e) {
        console.error("[catalogue] voice purge failed", r.id, e);
      }
    }
    total += n;
    if (n === 0) return total;
  }
}
