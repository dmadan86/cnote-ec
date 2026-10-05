// Drawings/specs on a requirement (buyer) or a quote (seller). Bytes go to the PRIVATE media bucket under
// `rfq/<enquiryId>/<attachmentId>.<ext>` and are only ever read through `openAttachment`, which authorises the caller
// and hands back a short-lived signed URL (or the bytes when the driver cannot sign). The AI intent scorer never sees
// attachments (ADR-008/ADR-010: minimise what leaves the platform).
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getAttachmentScanner, getMediaStore, ScanUnavailableError, sniffImageMime } from "@cnote/media";
import { randomUUID } from "node:crypto";
import type { Actor } from "./types";

export const MAX_RFQ_ATTACHMENTS = 5;
export const MAX_RFQ_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_QUOTE_ATTACHMENTS = 3;
export const MAX_QUOTE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 300;

export interface AttachmentUpload {
  fileName: string;
  bytes: Uint8Array;
}
export interface AttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}
export interface CheckedAttachment extends AttachmentUpload {
  mime: "application/pdf" | "image/jpeg" | "image/png";
  ext: "pdf" | "jpg" | "png";
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Type is decided from magic bytes, never from the client's filename or declared content type. */
export function checkAttachment(f: AttachmentUpload, maxBytes: number): CheckedAttachment {
  if (!f.bytes.length) throw new DomainError("validation", "One of the attachments is empty.");
  if (f.bytes.length > maxBytes) {
    throw new DomainError("validation", `Each attachment must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`);
  }
  if (PDF_MAGIC.every((b, i) => f.bytes[i] === b)) return { ...f, mime: "application/pdf", ext: "pdf" };
  const img = sniffImageMime(f.bytes);
  if (img === "image/jpeg") return { ...f, mime: "image/jpeg", ext: "jpg" };
  if (img === "image/png") return { ...f, mime: "image/png", ext: "png" };
  throw new DomainError("validation", "Attachments must be PDF, JPG or PNG files.");
}

/** Display name only: strip any path, control characters and cap the length. The storage key never contains it. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return clean || "attachment";
}

/** RFQ_ATTACHMENTS_ENABLED=false turns uploads off (e.g. while the scanner is down for a long time). Default on. */
export function attachmentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "no", "off"].includes((env.RFQ_ATTACHMENTS_ENABLED ?? "").trim().toLowerCase());
}

export function checkAttachments(files: AttachmentUpload[] | null | undefined, max: number, maxBytes: number): CheckedAttachment[] {
  const list = (files ?? []).filter((f) => f.bytes.length > 0 || f.fileName);
  if (list.length && !attachmentsEnabled()) throw new DomainError("validation", "Attachments are temporarily unavailable. Please send your requirement without files.");
  if (list.length > max) throw new DomainError("validation", `You can attach up to ${max} files.`);
  return list.map((f) => checkAttachment(f, maxBytes));
}

export const attachmentKey = (enquiryId: string, id: string, ext: string) => `rfq/${enquiryId}/${id}.${ext}`;

export interface StoredAttachment {
  id: string;
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Strictly increasing so the upload order is preserved when rows are read back. */
  createdAt: Date;
  /** malware scan evidence, persisted with the row */
  scannedAt: Date;
  scanner: string;
}

/** Who is uploading, and into what: needed to quarantine and notify when the scanner flags a file. */
export interface UploadContext {
  actor: Actor;
  kind: "rfq" | "quote";
}

export const quarantineKey = (enquiryId: string, id: string, ext: string) => `rfq/quarantine/${enquiryId}/${id}.${ext}`;

/**
 * Scans every file, then writes the clean ones to the private bucket. Scanning happens BEFORE any object or row exists, so
 * a file is never visible to the other party unscanned. A detection quarantines the bytes (private, never served),
 * records an AttachmentQuarantine row, emits AttachmentQuarantined (the uploader is notified) and rejects the whole upload.
 * A scanner that cannot answer is NOT "clean": the upload is rejected (fail closed). On any write failure the
 * already-written objects are removed.
 */
export async function storeAttachmentBytes(enquiryId: string, files: CheckedAttachment[], ctx: UploadContext): Promise<StoredAttachment[]> {
  const scanner = await resolveScanner();
  for (const f of files) {
    let verdict;
    try {
      verdict = await scanner.scan(f.bytes);
    } catch (err) {
      console.error("[enquiry] attachment scan unavailable:", err instanceof Error ? err.message : err);
      throw new DomainError("conflict", "We could not scan your attachment for viruses right now. Please try again in a few minutes.");
    }
    if (verdict.status === "infected") {
      await quarantine(enquiryId, f, ctx, verdict.signature, scanner.name);
      throw new DomainError("validation", "One of your attachments was blocked by our security scan. Remove it and try again.");
    }
  }
  const store = getMediaStore("private");
  const done: StoredAttachment[] = [];
  try {
    for (const f of files) {
      const id = randomUUID();
      const key = attachmentKey(enquiryId, id, f.ext);
      await store.put(key, f.bytes, f.mime);
      done.push({ id, key, fileName: safeFileName(f.fileName), mimeType: f.mime, sizeBytes: f.bytes.length, createdAt: new Date(Date.now() + done.length), scannedAt: new Date(), scanner: scanner.name });
    }
  } catch (err) {
    await discardStored(done);
    throw err;
  }
  return done;
}

async function resolveScanner() {
  try {
    return getAttachmentScanner();
  } catch (err) {
    if (err instanceof ScanUnavailableError) {
      console.error("[enquiry] attachment scanner misconfigured:", err.message);
      throw new DomainError("conflict", "We could not scan your attachment for viruses right now. Please try again in a few minutes.");
    }
    throw err;
  }
}

async function quarantine(enquiryId: string, f: CheckedAttachment, ctx: UploadContext, signature: string, scannerName: string): Promise<void> {
  const id = randomUUID();
  const key = quarantineKey(enquiryId, id, f.ext);
  let purgedAt: Date | null = null;
  try {
    await getMediaStore("private").put(key, f.bytes, f.mime);
  } catch (err) {
    // Still block and record it; there are simply no bytes to keep.
    console.error("[enquiry] could not write quarantined attachment:", err instanceof Error ? err.message : err);
    purgedAt = new Date();
  }
  await prisma.$transaction(async (tx) => {
    await tx.attachmentQuarantine.create({
      data: {
        id, enquiryId, kind: ctx.kind, uploadedByBusiness: ctx.actor.businessId, uploadedByPerson: ctx.actor.personId, key, fileName: safeFileName(f.fileName),
        mimeType: f.mime, sizeBytes: f.bytes.length, signature: signature.slice(0, 120), scanner: scannerName, purgedAt,
      },
    });
    await emit(tx, "AttachmentQuarantined", { type: "enquiry", id: enquiryId }, {
      quarantineId: id, enquiryId, kind: ctx.kind, uploadedByBusinessId: ctx.actor.businessId, uploadedByPersonId: ctx.actor.personId, signature: signature.slice(0, 120), scanner: scannerName,
    });
  });
}

/** Best-effort cleanup of objects whose DB rows were never committed. */
export async function discardStored(stored: StoredAttachment[]): Promise<void> {
  const store = getMediaStore("private");
  await Promise.all(stored.map((s) => store.delete(s.key).catch(() => undefined)));
}

const view = (a: { id: string; fileName: string; mimeType: string; sizeBytes: number }): AttachmentView => ({
  id: a.id,
  fileName: a.fileName,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
});

/** Requirement-level attachments for many enquiries (quoteId null), oldest first. */
export async function requirementAttachments(enquiryIds: string[]): Promise<Map<string, AttachmentView[]>> {
  const out = new Map<string, AttachmentView[]>();
  if (!enquiryIds.length) return out;
  const rows = await prisma.enquiryAttachment.findMany({ where: { enquiryId: { in: enquiryIds }, quoteId: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const r of rows) out.set(r.enquiryId, [...(out.get(r.enquiryId) ?? []), view(r)]);
  return out;
}

/** Quote-level attachments for many quotes, oldest first. */
export async function quoteAttachments(quoteIds: string[]): Promise<Map<string, AttachmentView[]>> {
  const out = new Map<string, AttachmentView[]>();
  if (!quoteIds.length) return out;
  const rows = await prisma.enquiryAttachment.findMany({ where: { quoteId: { in: quoteIds } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const r of rows) if (r.quoteId) out.set(r.quoteId, [...(out.get(r.quoteId) ?? []), view(r)]);
  return out;
}

export interface AttachmentAccess {
  fileName: string;
  mimeType: string;
  /** Short-lived direct URL (R2/S3). Null on the local driver: stream `bytes` through an authenticated route instead. */
  signedUrl: string | null;
  bytes: Uint8Array | null;
}

/**
 * Authorised read. Visible to: the buyer business that owns the enquiry; the seller business that holds an offered or
 * accepted lead on it (the drawings are part of the requirement a seller decides on); the seller who uploaded a quote
 * attachment. Anyone else gets `null`, indistinguishable from "not found".
 */
export async function openAttachment(actor: Actor, attachmentId: string): Promise<AttachmentAccess | null> {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return null;
  const a = await prisma.enquiryAttachment.findUnique({ where: { id: attachmentId }, include: { enquiry: { select: { buyerBusinessId: true } } } });
  if (!a) return null;
  let allowed = a.enquiry.buyerBusinessId === actor.businessId || a.uploadedByBusiness === actor.businessId;
  if (!allowed && a.quoteId === null) {
    allowed = (await prisma.match.count({ where: { enquiryId: a.enquiryId, sellerBusinessId: actor.businessId, status: { in: ["offered", "accepted"] } } })) > 0;
  }
  if (!allowed) return null;
  const store = getMediaStore("private");
  const signedUrl = await store.signedGetUrl(a.key, SIGNED_URL_TTL_SECONDS);
  if (signedUrl) return { fileName: a.fileName, mimeType: a.mimeType, signedUrl, bytes: null };
  const obj = await store.get(a.key);
  if (!obj) return null;
  return { fileName: a.fileName, mimeType: a.mimeType, signedUrl: null, bytes: obj.bytes };
}
