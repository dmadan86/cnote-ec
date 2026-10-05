// Malware scanning port for user uploads that other users download (RFQ drawings, quote attachments).
// Adapters: `mock` (default; detects the EICAR test string only, so dev and CI exercise the whole quarantine path) and
// `clamav` (clamd over TCP, INSTREAM protocol). A scanner failure is an ERROR, never "clean": callers fail closed.
//
// Env: ATTACHMENT_SCANNER=mock|clamav (default mock). clamav: CLAMAV_HOST (required), CLAMAV_PORT (3310),
// CLAMAV_TIMEOUT_MS (overall budget, default 15000), CLAMAV_CONNECT_TIMEOUT_MS (default 3000), CLAMAV_CHUNK_BYTES (default 65536).
import net from "node:net";

export type ScanVerdict = { status: "clean" } | { status: "infected"; signature: string };

export interface AttachmentScanner {
  readonly name: string;
  /** Resolves with a verdict, rejects with ScanUnavailableError when no verdict could be reached (fail closed). */
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

/** The scanner could not give a verdict (down, timed out, protocol error, size limit). Callers must NOT treat the file as clean. */
export class ScanUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScanUnavailableError";
  }
}

/** The industry-standard antivirus test file (68 bytes). Harmless; every scanner flags it. */
export const EICAR_TEST_STRING = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EICAR_BYTES = Buffer.from(EICAR_TEST_STRING, "latin1");
export const EICAR_SIGNATURE = "Eicar-Test-Signature";

/** Detects EICAR anywhere in the file (it is often embedded in a document or padded). Not a real scanner: dev, CI and tests only. */
export class MockAttachmentScanner implements AttachmentScanner {
  readonly name = "mock";
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(EICAR_BYTES) ? { status: "infected", signature: EICAR_SIGNATURE } : { status: "clean" };
  }
}

export interface ClamdOptions {
  host: string;
  port?: number;
  /** overall budget for one scan, connect to reply */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  chunkBytes?: number;
}

/** clamd answers `stream: OK`, `stream: <Signature> FOUND` or `... ERROR`, NUL-terminated (we send the z-prefixed command). */
export function parseClamdReply(raw: string): ScanVerdict {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 0) end--;
  const reply = raw.slice(0, end).trim();
  if (/^stream:\s*OK$/i.test(reply)) return { status: "clean" };
  const head = /^stream:\s{0,16}/i.exec(reply);
  if (head && reply.slice(-5).toUpperCase() === "FOUND") {
    const body = reply.slice(head[0].length, -5);
    const sig = body.trimEnd();
    if (sig.length > 0 && sig.length < body.length) return { status: "infected", signature: sig.slice(0, 120) };
  }
  throw new ScanUnavailableError(`clamd replied: ${reply.slice(0, 200) || "(empty)"}`);
}

/**
 * clamd INSTREAM: `zINSTREAM\0`, then `<4-byte big-endian length><chunk>` repeated, then a zero length. clamd reads the
 * stream, scans it, and replies once. Connect timeout, idle timeout and an overall deadline all apply.
 */
export class ClamdAttachmentScanner implements AttachmentScanner {
  readonly name = "clamav";
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly chunkBytes: number;

  constructor(private readonly opts: ClamdOptions) {
    this.port = opts.port ?? 3310;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 3_000;
    this.chunkBytes = Math.max(1024, Math.min(opts.chunkBytes ?? 65_536, 1024 * 1024));
  }

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket = net.createConnection({ host: this.opts.host, port: this.port });
      const reply: Buffer[] = [];
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(connectTimer);
        clearTimeout(deadline);
        socket.destroy();
        fn();
      };
      const fail = (message: string, cause?: unknown) => finish(() => reject(new ScanUnavailableError(message, { cause })));
      const connectTimer = setTimeout(() => fail(`clamd connect timed out after ${this.connectTimeoutMs}ms`), this.connectTimeoutMs);
      const deadline = setTimeout(() => fail(`clamd scan timed out after ${this.timeoutMs}ms`), this.timeoutMs);

      socket.on("connect", () => {
        clearTimeout(connectTimer);
        socket.write("zINSTREAM\0");
        const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let off = 0; off < buf.length; off += this.chunkBytes) {
          const chunk = buf.subarray(off, off + this.chunkBytes);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
      socket.on("data", (d: Buffer) => {
        reply.push(d);
        if (d.includes(0)) socket.end(); // reply is NUL-terminated
      });
      socket.on("error", (e) => fail(`clamd connection error: ${e.message}`, e));
      socket.on("close", () => {
        if (done) return;
        try {
          const text = Buffer.concat(reply).toString("utf8");
          if (!text) return fail("clamd closed the connection without a reply");
          const verdict = parseClamdReply(text);
          finish(() => resolve(verdict));
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e), e);
        }
      });
    });
  }
}

export type ScannerKind = "mock" | "clamav";

/** The configured adapter name. Anything but `clamav` is the mock (so an unset env in dev just works; production validation rejects it). */
export function scannerKind(env: Record<string, string | undefined> = process.env): ScannerKind {
  return (env.ATTACHMENT_SCANNER ?? "mock").trim().toLowerCase() === "clamav" ? "clamav" : "mock";
}

let override: AttachmentScanner | null = null;
let cached: { key: string; scanner: AttachmentScanner } | null = null;

const int = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

export function getAttachmentScanner(env: Record<string, string | undefined> = process.env): AttachmentScanner {
  if (override) return override;
  const kind = scannerKind(env);
  if (kind === "mock") return (cached?.key === "mock" ? cached : (cached = { key: "mock", scanner: new MockAttachmentScanner() })).scanner;
  const host = env.CLAMAV_HOST?.trim();
  if (!host) throw new ScanUnavailableError("ATTACHMENT_SCANNER=clamav needs CLAMAV_HOST");
  const key = `clamav:${host}:${env.CLAMAV_PORT ?? ""}:${env.CLAMAV_TIMEOUT_MS ?? ""}`;
  if (cached?.key !== key) {
    cached = {
      key,
      scanner: new ClamdAttachmentScanner({
        host, port: int(env.CLAMAV_PORT), timeoutMs: int(env.CLAMAV_TIMEOUT_MS), connectTimeoutMs: int(env.CLAMAV_CONNECT_TIMEOUT_MS), chunkBytes: int(env.CLAMAV_CHUNK_BYTES),
      }),
    };
  }
  return cached.scanner;
}

/** Test hook: pin a scanner (null restores env-based selection). */
export function setAttachmentScannerForTests(s: AttachmentScanner | null): void {
  override = s;
  cached = null;
}
