// Synthetic fixtures without extra deps (sharp is not an @cnote/ai dependency): a tiny PNG encoder over node:zlib,
// a hand-built EXIF-carrying JPEG header, and audio stubs the mock ASR understands.
import { deflateSync } from "node:zlib";
import { MOCK_TRANSCRIPT_PREFIX } from "../src/speech";

const CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export type Pattern = "stripes" | "checker" | "gradient" | "circles";
export type RGB = [number, number, number];

/** Deterministic RGB PNG with a recognisable pattern (better than a flat colour for pipeline/regression checks). */
export function syntheticPng(w: number, h: number, pattern: Pattern, a: RGB, b: RGB = [245, 245, 245]): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = pattern === "stripes" ? ((x >> 4) & 1) : pattern === "checker" ? (((x >> 5) ^ (y >> 5)) & 1)
        : pattern === "gradient" ? x / w : Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) / 3 ? 1 : 0;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(a[c]! * (1 - t) + b[c]! * t);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return Buffer.concat(parts);
}

/** Minimal JPEG-shaped header carrying an APP1 "Exif" segment (for the EXIF-rejection guard). Not decodable. */
export function jpegWithExif(): Uint8Array {
  const exif = Buffer.from("Exif\0\0MM\0*\0\0\0\b\0\0", "binary");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}
/** Same header without metadata. */
export const jpegNoExif = (): Uint8Array => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);

/** Audio stub the mock ASR transcribes to `text` (real providers need real recordings: see evals/audio/README). */
export const mockAudio = (text: string): Uint8Array => new TextEncoder().encode(MOCK_TRANSCRIPT_PREFIX + text);
