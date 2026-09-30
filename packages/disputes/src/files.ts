// Evidence uploads: validation + storage under the PRIVATE key prefix `disputes/<disputeId>/<evidenceId>.<ext>`.
import { DomainError } from "@cnote/core";
import { AUDIO_EXT, assertAudio } from "@cnote/ai";
import { IMAGE_EXT, sniffImageMime } from "@cnote/media";

export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 6;

export type UploadKind = "photo" | "document" | "voice";
export interface EvidenceUpload {
  kind: UploadKind;
  bytes: Uint8Array;
  /** declared MIME (photos/documents are verified from magic bytes; voice from the audio allowlist) */
  mimeType: string;
}
export interface CheckedUpload { kind: UploadKind; bytes: Uint8Array; mime: string; ext: string }

const PDF = [0x25, 0x50, 0x44, 0x46];

export function checkUpload(u: EvidenceUpload): CheckedUpload {
  if (!u.bytes.length) throw new DomainError("validation", "The file is empty.");
  if (u.bytes.length > MAX_EVIDENCE_BYTES) throw new DomainError("validation", "Each file must be 8 MB or smaller.");
  if (u.kind === "photo") {
    const mime = sniffImageMime(u.bytes);
    if (!mime) throw new DomainError("validation", "Photos must be JPEG, PNG or WebP.");
    return { kind: "photo", bytes: u.bytes, mime, ext: IMAGE_EXT[mime] };
  }
  if (u.kind === "document") {
    if (!PDF.every((b, i) => u.bytes[i] === b)) throw new DomainError("validation", "Documents must be PDF files.");
    return { kind: "document", bytes: u.bytes, mime: "application/pdf", ext: "pdf" };
  }
  const base = assertAudio({ bytes: u.bytes, mimeType: u.mimeType });
  const ext = AUDIO_EXT[base]!;
  // The private-store MIME table knows these extensions; normalise aliases to the type it expects.
  const canonical: Record<string, string> = { ogg: "audio/ogg", opus: "audio/opus", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", webm: "audio/webm" };
  return { kind: "voice", bytes: u.bytes, mime: canonical[ext]!, ext };
}

export const evidenceKey = (disputeId: string, evidenceId: string, ext: string) => `disputes/${disputeId}/${evidenceId}.${ext}`;
