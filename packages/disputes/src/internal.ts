// Shared internals: guards, row locking, evidence ingestion (uploads + voice transcription), view mappers.
import { randomUUID } from "node:crypto";
import { transcribe } from "@cnote/ai";
import { DomainError } from "@cnote/core";
import { prisma, type Dispute, type DisputeEvidence, type Tx } from "@cnote/db";
import { disputesEnabled } from "./config";
import { checkUpload, evidenceKey, MAX_EVIDENCE_FILES, type EvidenceUpload } from "./files";
import { evidenceStore } from "./ports";
import type { Actor, DisputeStatus, EvidenceView, Lang, PartyRole } from "./types";

export const UUID = /^[0-9a-f-]{36}$/i;
export const MAX_TEXT = 4000;
export const MAX_EVIDENCE_PER_PARTY = 30;

export function requireEnabled(): void {
  if (!disputesEnabled()) throw new DomainError("forbidden", "Dispute resolution is not available yet.", undefined, "disputes.disputeResolutionNotAvailableYet");
}

export const num = (v: bigint | null): number | null => (v === null ? null : Number(v));
export const status = (d: Pick<Dispute, "status">) => d.status as DisputeStatus;

export function roleOf(d: Pick<Dispute, "openedByBusinessId" | "againstBusinessId" | "openedByRole">, businessId: string): PartyRole | null {
  if (d.openedByBusinessId === businessId) return d.openedByRole as PartyRole;
  if (d.againstBusinessId === businessId) return d.openedByRole === "buyer" ? "seller" : "buyer";
  return null;
}

/** Row lock on the dispute (own table) so concurrent actions serialise. */
export async function lockDispute(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${id}::uuid FOR UPDATE`;
}

/** Loads a dispute the actor is a party to; non-parties get not_found (indistinguishable from missing). */
export async function loadForParty(actor: Actor, id: string, tx: Pick<Tx, "dispute"> = prisma): Promise<{ d: Dispute; role: PartyRole }> {
  if (!UUID.test(id)) throw new DomainError("not_found", "Dispute not found");
  const d = await tx.dispute.findUnique({ where: { id } });
  const role = d ? roleOf(d, actor.businessId) : null;
  if (!d || !role) throw new DomainError("not_found", "Dispute not found");
  return { d, role };
}

export interface PreparedEvidence {
  id: string;
  kind: "statement" | "photo" | "document" | "voice";
  text: string | null;
  mediaKey: string | null;
  mimeType: string | null;
  language: string | null;
}

/**
 * Validates + stores uploads (PRIVATE bucket) and transcribes voice notes. Returns rows to insert plus a cleanup that
 * deletes the stored objects again if the surrounding transaction fails. `text` (typed statement) becomes a statement row.
 */
export async function prepareEvidence(
  disputeId: string,
  input: { text?: string; language?: Lang; voiceConsent?: boolean; uploads?: EvidenceUpload[] },
): Promise<{ rows: PreparedEvidence[]; transcript: string | null; cleanup: () => Promise<void> }> {
  const uploads = input.uploads ?? [];
  if (uploads.length > MAX_EVIDENCE_FILES) throw new DomainError("validation", `Attach at most ${MAX_EVIDENCE_FILES} files at a time.`, undefined, "disputes.attachMostFilesTime", { maxEvidenceFiles: MAX_EVIDENCE_FILES });
  const checked = uploads.map(checkUpload); // validate everything before storing anything
  if (checked.some((c) => c.kind === "voice") && !input.voiceConsent) {
    throw new DomainError("validation", "Please consent to us storing and transcribing your voice note (DPDP).");
  }
  const text = input.text?.trim() ?? "";
  if (text.length > MAX_TEXT) throw new DomainError("validation", `Keep the statement under ${MAX_TEXT} characters.`, undefined, "disputes.keepStatementUnderCharacters", { maxText: MAX_TEXT });

  const rows: PreparedEvidence[] = [];
  const stored: string[] = [];
  const cleanup = async () => { await Promise.all(stored.map((k) => evidenceStore().delete(k).catch(() => undefined))); };
  let transcript: string | null = null;
  try {
    if (text) rows.push({ id: randomUUID(), kind: "statement", text, mediaKey: null, mimeType: null, language: input.language ?? null });
    for (const c of checked) {
      const id = randomUUID();
      let t: string | null = null;
      let lang: string | null = input.language ?? null;
      if (c.kind === "voice") {
        const r = await transcribe({ audio: { bytes: c.bytes, mimeType: c.mime }, languageHint: input.language }, { type: "voice_note", id: disputeId });
        t = r.text.trim() || null;
        lang = r.language && r.language !== "unknown" ? r.language : lang;
        transcript ??= t;
      }
      const key = evidenceKey(disputeId, id, c.ext);
      await evidenceStore().put(key, c.bytes, c.mime);
      stored.push(key);
      rows.push({ id, kind: c.kind, text: t, mediaKey: key, mimeType: c.mime, language: lang });
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { rows, transcript, cleanup };
}

export function toEvidenceView(e: DisputeEvidence, viewerBusinessId: string | null): EvidenceView {
  return {
    id: e.id, party: e.party, mine: viewerBusinessId !== null && e.submittedByBusinessId === viewerBusinessId, kind: e.kind, text: e.text,
    hasFile: e.mediaKey !== null, mimeType: e.mimeType, source: e.source, purged: e.purgedAt !== null, createdAt: e.createdAt.toISOString(),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}
