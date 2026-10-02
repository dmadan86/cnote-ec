// Zip-bomb guard (security audit M9). Header-declared sizes are attacker-controlled, so every limit here is enforced
// on the bytes ACTUALLY inflated, using fflate's streaming Unzip with a byte budget: inflation stops (terminate) the
// moment a budget is crossed, so a 1 KB archive that expands to gigabytes never allocates them.
import { DomainError } from "@cnote/core";
import { Unzip, UnzipInflate, unzipSync, type UnzipFile } from "fflate";

export interface ZipScanOptions {
  /** budget for the sum of actually inflated bytes across entries that are inflated */
  maxTotalBytes: number;
  /** entries (files) allowed in the archive, counted from the headers as they are met */
  maxEntries: number;
  /** a single entry may inflate to at most this many bytes */
  maxEntryBytes: number;
  /** return false to skip an entry without inflating it (junk, or not wanted); may throw to reject the archive */
  inflate?: (name: string) => boolean;
  /** return a retention cap (bytes) to keep an entry's data in the result; false/undefined = count only. Beyond the cap data is dropped. */
  collect?: (name: string) => number | false | undefined;
  /** sees the first inflated chunk of each entry (used to read an xlsx sheet's declared dimension) */
  peek?: (name: string, firstChunk: Uint8Array) => void;
  messages: { tooMany: string; tooBig: string; entryTooBig?: (name: string) => string; unreadable: string };
}

export interface ZipScanResult {
  /** actual inflated size per inflated entry */
  entries: { name: string; size: number }[];
  files: Map<string, Uint8Array>;
  totalBytes: number;
}

const concat = (chunks: Uint8Array[], size: number): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

export function scanZip(bytes: Uint8Array, opts: ZipScanOptions): ZipScanResult {
  // Structure check from the central directory (no inflation): rejects truncated/corrupt archives and an absurd entry count up front.
  let declared = 0;
  try {
    unzipSync(bytes, { filter: () => { if (++declared > opts.maxEntries) throw new DomainError("validation", opts.messages.tooMany); return false; } });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("validation", opts.messages.unreadable);
  }
  const entries: ZipScanResult["entries"] = [];
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let count = 0;
  // Errors are recorded and re-thrown after the push: fflate's own try/catch would otherwise swallow a throw from a callback.
  let failure: DomainError | null = null;
  const fail = (m: string) => { failure ??= new DomainError("validation", m); };
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file: UnzipFile) => {
    if (failure) return;
    if (++count > opts.maxEntries) return fail(opts.messages.tooMany);
    try {
      if (opts.inflate && !opts.inflate(file.name)) return; // never started: not inflated, no cost
    } catch (e) {
      failure ??= e instanceof DomainError ? e : new DomainError("validation", opts.messages.unreadable);
      return;
    }
    const cap = opts.collect?.(file.name) || 0;
    const chunks: Uint8Array[] = [];
    let kept = 0;
    let size = 0;
    let first = true;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) return fail(opts.messages.unreadable);
      size += chunk.length;
      total += chunk.length;
      if (total > opts.maxTotalBytes) { file.terminate(); return fail(opts.messages.tooBig); }
      if (size > opts.maxEntryBytes) { file.terminate(); return fail(opts.messages.entryTooBig?.(file.name) ?? opts.messages.tooBig); }
      if (first && chunk.length) {
        first = false;
        try { opts.peek?.(file.name, chunk); } catch (e) { failure ??= e instanceof DomainError ? e : new DomainError("validation", opts.messages.unreadable); file.terminate(); return; }
      }
      if (cap && kept + chunk.length <= cap) { chunks.push(chunk.slice()); kept += chunk.length; }
      if (final) {
        entries.push({ name: file.name, size });
        if (cap && size <= cap) files.set(file.name, kept ? concat(chunks, kept) : new Uint8Array(0));
      }
    };
    file.start();
  };
  try {
    // Feed the archive in small slices: fflate inflates everything pushed to it in one go, so a single push of a whole
    // bomb would allocate its full expansion before any budget check runs. A slice expands at most ~1032x.
    for (let i = 0; i < bytes.length && !failure; i += PUSH_SLICE) {
      unzip.push(bytes.subarray(i, Math.min(i + PUSH_SLICE, bytes.length)), i + PUSH_SLICE >= bytes.length);
    }
  } catch (e) {
    if (failure) throw failure;
    if (e instanceof DomainError) throw e;
    throw new DomainError("validation", opts.messages.unreadable);
  }
  if (failure) throw failure;
  return { entries, files, totalBytes: total };
}

const PUSH_SLICE = 16 * 1024;

/** "A1:XFD1048576" -> { rows, cols } (declared; used only as an early reject, the post-load check is authoritative). */
export function parseDimension(xmlHead: string): { rows: number; cols: number } | null {
  const m = /<dimension\s+ref="([A-Z]{1,3})(\d{1,8})(?::([A-Z]{1,3})(\d{1,8}))?"/.exec(xmlHead);
  if (!m) return null;
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  const c1 = col(m[1]!), r1 = Number(m[2]);
  const c2 = m[3] ? col(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
  return { rows: Math.max(0, r2 - r1 + 1), cols: Math.max(0, c2 - c1 + 1) };
}
