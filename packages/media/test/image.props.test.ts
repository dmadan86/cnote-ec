import fc from "fast-check";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  IMAGE_EXT, ImageValidationError, MAX_DIMENSION, MAX_IMAGE_BYTES, MIN_DIMENSION, isValidListingImageKey, listingImageKey, readImageDimensions, sha256Hex, sniffImageMime, validateImage,
  type ImageMime,
} from "../src/index";

const opts = { seed: 8, numRuns: 200 };
type Fmt = "jpeg" | "png" | "webp-lossy" | "webp-lossless" | "webp-alpha";
const MIME: Record<Fmt, ImageMime> = { jpeg: "image/jpeg", png: "image/png", "webp-lossy": "image/webp", "webp-lossless": "image/webp", "webp-alpha": "image/webp" };

async function real(fmt: Fmt, w: number, h: number): Promise<Uint8Array> {
  const alpha = fmt === "webp-alpha";
  const s = sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 1, g: 2, b: 3, alpha: 0.5 } : { r: 10, g: 120, b: 200 } } });
  const buf = fmt === "jpeg" ? await s.jpeg().toBuffer() : fmt === "png" ? await s.png().toBuffer() : await s.webp(fmt === "webp-lossless" ? { lossless: true } : {}).toBuffer();
  return new Uint8Array(buf);
}

describe("real encoder output: sniff + dimensions agree with sharp", () => {
  const fmts: Fmt[] = ["jpeg", "png", "webp-lossy", "webp-lossless", "webp-alpha"];
  it.each(fmts)("%s across sizes", async (fmt) => {
    for (const [w, h] of [[200, 200], [201, 333], [640, 480], [1, 1], [16383 > 3000 ? 3000 : 1, 10], [777, 1]] as const) {
      const bytes = await real(fmt, w, h);
      expect(sniffImageMime(bytes), `${fmt} ${w}x${h}`).toBe(MIME[fmt]);
      const m = await sharp(bytes).metadata();
      expect(readImageDimensions(bytes, MIME[fmt]), `${fmt} ${w}x${h}`).toEqual({ width: m.width, height: m.height });
    }
  });

  it("PROPERTY: header dimensions equal the real dimensions for random sizes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...fmts), fc.integer({ min: 1, max: 900 }), fc.integer({ min: 1, max: 900 }), async (fmt, w, h) => {
        const bytes = await real(fmt, w, h);
        expect(readImageDimensions(bytes, MIME[fmt])).toEqual({ width: w, height: h });
      }),
      { seed: 4, numRuns: 40 },
    );
  });

  it("progressive JPEG, JPEG with EXIF (APPn segments before SOF) and PNG with metadata parse correctly", async () => {
    const prog = new Uint8Array(await sharp({ create: { width: 333, height: 222, channels: 3, background: "#123456" } }).jpeg({ progressive: true }).toBuffer());
    expect(readImageDimensions(prog, "image/jpeg")).toEqual({ width: 333, height: 222 });
    const exif = new Uint8Array(await sharp({ create: { width: 410, height: 300, channels: 3, background: "#654321" } }).withExif({ IFD0: { Copyright: "x".repeat(2000) } }).jpeg().toBuffer());
    expect(readImageDimensions(exif, "image/jpeg")).toEqual({ width: 410, height: 300 });
    const png = new Uint8Array(await sharp({ create: { width: 250, height: 260, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png({ palette: true }).toBuffer());
    expect(readImageDimensions(png, "image/png")).toEqual({ width: 250, height: 260 });
  });
});

describe("truncation / corruption never crashes and never invents a valid image", () => {
  it("every prefix of every real format: no throw; result is null or the true dimensions", async () => {
    for (const fmt of ["jpeg", "png", "webp-lossy", "webp-lossless", "webp-alpha"] as const) {
      const bytes = await real(fmt, 321, 234);
      const limit = Math.min(bytes.length, 400); // headers live at the start
      for (let n = 0; n <= limit; n++) {
        const cut = bytes.subarray(0, n);
        const d = readImageDimensions(cut, MIME[fmt]);
        if (d) {
          expect(d, `${fmt} prefix ${n}`).toEqual({ width: 321, height: 234 });
          expect(validateImage(cut).width, `${fmt} prefix ${n}`).toBe(321); // header-level validation only; decoding (processImage) catches truncated pixel data
        } else {
          expect(() => validateImage(cut), `${fmt} prefix ${n}`).toThrow(ImageValidationError);
        }
      }
    }
  });

  it("PROPERTY: random bytes never throw from sniff/readImageDimensions, and validateImage only throws ImageValidationError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.constantFrom<ImageMime>("image/jpeg", "image/png", "image/webp"), (b, mime) => {
        expect(() => sniffImageMime(b)).not.toThrow();
        expect(() => readImageDimensions(b, mime)).not.toThrow();
        try {
          validateImage(b);
        } catch (e) {
          expect(e).toBeInstanceOf(ImageValidationError);
        }
      }),
      { ...opts, numRuns: 1000 },
    );
  });

  it("PROPERTY: magic bytes + random tail never throw; dimensions when present are positive integers", () => {
    const heads: number[][] = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]];
    fc.assert(
      fc.property(fc.constantFrom(...heads), fc.uint8Array({ maxLength: 120 }), (head, tail) => {
        const b = new Uint8Array([...head, ...tail]);
        const mime = sniffImageMime(b)!;
        expect(mime).toBeTruthy();
        const d = readImageDimensions(b, mime);
        if (d) {
          expect(Number.isInteger(d.width) && d.width > 0).toBe(true);
          expect(Number.isInteger(d.height) && d.height > 0).toBe(true);
        }
      }),
      { ...opts, numRuns: 1000 },
    );
  });

  it("JPEG crafted headers: marker garbage, zero/one-byte lengths, SOS before SOF, EOI, fill bytes", () => {
    const j = (...body: number[]) => new Uint8Array([0xff, 0xd8, ...body]);
    expect(readImageDimensions(j(0xff, 0xda, 0, 2), "image/jpeg")).toBeNull(); // SOS before SOF
    expect(readImageDimensions(j(0xff, 0xd9, 0, 0), "image/jpeg")).toBeNull(); // EOI
    expect(readImageDimensions(j(0xff, 0xe0, 0, 0, 0, 0), "image/jpeg")).toBeNull(); // segment length 0 (would loop forever if unchecked)
    expect(readImageDimensions(j(0xff, 0xe0, 0, 1, 0, 0), "image/jpeg")).toBeNull(); // length 1
    expect(readImageDimensions(j(0x00, 0x00, 0x00, 0x00), "image/jpeg")).toBeNull(); // not a marker
    expect(readImageDimensions(j(0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0), "image/jpeg")).toBeNull(); // 0x0
    expect(readImageDimensions(j(0xff, 0xc0, 0, 11, 8, 1, 0, 2, 0, 1, 1, 0x11, 0), "image/jpeg")).toEqual({ width: 512, height: 256 });
    expect(readImageDimensions(j(0xff, 0xff, 0xff, 0xc0, 0, 11, 8, 1, 0, 2, 0, 1, 1, 0x11, 0), "image/jpeg")).toEqual({ width: 512, height: 256 }); // fill bytes
    expect(readImageDimensions(j(0xff, 0xc4, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0, 9, 0, 8, 1, 1, 0x11, 0), "image/jpeg")).toEqual({ width: 8, height: 9 }); // DHT skipped, progressive SOF2
    expect(readImageDimensions(j(0xff, 0xc4, 0, 11, 8, 0, 9, 0, 8, 1, 1, 0x11, 0), "image/jpeg")).toBeNull(); // DHT (0xc4) is not a SOF
    expect(readImageDimensions(j(0xff, 0xc8, 0, 11, 8, 0, 9, 0, 8, 1, 1, 0x11, 0), "image/jpeg")).toBeNull(); // JPG extension marker
    expect(readImageDimensions(j(0xff, 0xcc, 0, 11, 8, 0, 9, 0, 8, 1, 1, 0x11, 0), "image/jpeg")).toBeNull(); // DAC
    expect(readImageDimensions(j(0xff, 0xd0, 0xff, 0xc0, 0, 11, 8, 1, 0, 2, 0, 1, 1, 0x11, 0), "image/jpeg")).toEqual({ width: 512, height: 256 }); // RSTn has no length
    expect(readImageDimensions(j(0xff, 0xe0, 0xff, 0xff), "image/jpeg")).toBeNull(); // length beyond EOF
    expect(readImageDimensions(j(0xff, 0xc0, 0, 11, 8, 1, 0), "image/jpeg")).toBeNull(); // SOF cut short
  });

  it("PNG crafted headers: wrong chunk, zero/huge dimensions", () => {
    const png = (chunk: string, w: number, h: number) => {
      const b = new Uint8Array(33);
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.from(chunk)]);
      new DataView(b.buffer).setUint32(16, w);
      new DataView(b.buffer).setUint32(20, h);
      return b;
    };
    expect(readImageDimensions(png("IDAT", 300, 300), "image/png")).toBeNull();
    expect(readImageDimensions(png("IHDR", 0, 300), "image/png")).toBeNull();
    expect(readImageDimensions(png("IHDR", 300, 0), "image/png")).toBeNull();
    expect(readImageDimensions(png("IHDR", 0xffffffff, 0xffffffff), "image/png")).toEqual({ width: 4294967295, height: 4294967295 }); // parsed unsigned, no int overflow
    expect(() => validateImage(png("IHDR", 0xffffffff, 300))).toThrow(/at most/);
    expect(() => validateImage(png("IHDR", 0x80000000, 300))).toThrow(/at most/); // would be negative if read signed
  });

  it("WebP crafted headers: bad start codes/signatures, unknown chunk, mismatched mime", () => {
    const riff = (fourcc: string, rest: number[], len = 30) => {
      const b = new Uint8Array(len);
      b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(fourcc), 0, 0, 0, 0, ...rest]);
      return b;
    };
    expect(readImageDimensions(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/webp")).toBeNull(); // bad start code
    expect(readImageDimensions(riff("VP8L", [0, 0, 0, 0]), "image/webp")).toBeNull(); // missing 0x2f signature
    expect(readImageDimensions(riff("ABCD", []), "image/webp")).toBeNull();
    expect(readImageDimensions(riff("VP8X", []), "image/webp", )).toEqual({ width: 1, height: 1 });
    expect(readImageDimensions(riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).subarray(0, 29), "image/webp")).toBeNull(); // < 30 bytes
    // 24-bit maximum canvas size parses (and is then rejected by validateImage as too large)
    const big = riff("VP8X", [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff].slice(0, 10));
    big.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 24);
    expect(readImageDimensions(big, "image/webp")).toEqual({ width: 16777216, height: 16777216 });
    expect(() => validateImage(big)).toThrow(/at most/);
  });

  it("reading with the wrong declared mime never throws and yields null for real data of another type", async () => {
    const png = await real("png", 300, 300);
    const jpg = await real("jpeg", 300, 300);
    expect(readImageDimensions(png, "image/jpeg")).toBeNull();
    expect(readImageDimensions(jpg, "image/png")).toBeNull();
    expect(readImageDimensions(jpg, "image/webp")).toBeNull();
  });
});

describe("spoofed types: only magic bytes count", () => {
  const text = (s: string) => new TextEncoder().encode(s);
  it.each([
    ["SVG", text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ["SVG with xml prolog", text('<?xml version="1.0"?><svg/>')],
    ["HTML", text("<!doctype html><script>alert(1)</script>")],
    ["GIF87a", text("GIF87a\x01\x00\x01\x00")],
    ["GIF89a", text("GIF89a\x01\x00\x01\x00")],
    ["BMP", text("BM\x00\x00\x00\x00\x00\x00\x00\x00")],
    ["PDF", text("%PDF-1.7\n")],
    ["ZIP", new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])],
    ["ELF", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])],
    ["PHP", text("<?php system($_GET['c']); ?>")],
    ["RIFF WAVE", new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVEfmt "), 0, 0, 0, 0])],
    ["RIFF AVI", new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("AVI LIST"), 0, 0, 0, 0])],
    ["AVIF/HEIC (ftyp)", new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypavif"), 0, 0, 0, 0, 0, 0, 0, 0])],
    ["TIFF LE", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])],
    ["JPEG-like but 2 bytes", new Uint8Array([0xff, 0xd8])],
    ["PNG signature cut", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])],
    ["PNG with wrong line ending", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0d, 0x1a, 0x0a])],
    ["RIFF but WEB", new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBX")])],
    ["riff lowercase", new Uint8Array([...Buffer.from("riff"), 0, 0, 0, 0, ...Buffer.from("webp")])],
    ["UTF-8 BOM text", new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x73, 0x76, 0x67])],
  ])("%s is rejected regardless of any filename or content-type claims", (_n, bytes) => {
    expect(sniffImageMime(bytes)).toBeNull();
    expect(() => validateImage(bytes)).toThrow(/JPEG, PNG or WebP/);
  });

  it("a polyglot with an image header followed by script is still classified by its header (never as SVG/HTML)", () => {
    const b = new Uint8Array([0xff, 0xd8, 0xff, ...Buffer.from("<script>alert(1)</script>")]);
    expect(sniffImageMime(b)).toBe("image/jpeg");
    expect(readImageDimensions(b, "image/jpeg")).toBeNull();
    expect(() => validateImage(b)).toThrow(/corrupt/);
  });

  it("extension in the result derives only from the sniffed type", async () => {
    const v = validateImage(await real("png", 300, 300));
    expect(v.ext).toBe("png");
    expect(IMAGE_EXT).toEqual({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
  });
});

describe("validateImage limits (boundaries)", () => {
  const dims = async (w: number, h: number) => real("png", w, h);
  it("accepts exactly MIN/MAX and rejects one beyond", async () => {
    expect(validateImage(await dims(MIN_DIMENSION, MIN_DIMENSION))).toMatchObject({ width: 200, height: 200 });
    expect(() => validateImage(pngHeader(MIN_DIMENSION - 1, 400))).toThrow(/at least 200x200/);
    expect(() => validateImage(pngHeader(400, MIN_DIMENSION - 1))).toThrow(/at least/);
    expect(validateImage(pngHeader(MAX_DIMENSION, MAX_DIMENSION))).toMatchObject({ width: 6000, height: 6000 });
    expect(() => validateImage(pngHeader(MAX_DIMENSION + 1, 400))).toThrow(/at most 6000x6000/);
    expect(() => validateImage(pngHeader(400, MAX_DIMENSION + 1))).toThrow(/at most/);
  });
  it("size limit is inclusive at 5 MB and checked before parsing", () => {
    const ok = new Uint8Array(MAX_IMAGE_BYTES);
    ok.set(pngHeader(300, 300));
    expect(validateImage(ok).bytes).toBe(MAX_IMAGE_BYTES);
    const over = new Uint8Array(MAX_IMAGE_BYTES + 1); // not even an image: must fail on size, cheaply
    expect(() => validateImage(over)).toThrow(/5 MB/);
  });
  it("empty input; sha256 is over the exact bytes", () => {
    expect(() => validateImage(new Uint8Array())).toThrow("The file is empty");
    const b = pngHeader(300, 300);
    expect(validateImage(b).sha256).toBe(sha256Hex(b));
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const c = b.slice();
    c[32] = c[32]! ^ 1;
    expect(sha256Hex(c)).not.toBe(sha256Hex(b));
  });
  it("PROPERTY: any header dimensions inside limits are accepted, outside are rejected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9000 }), fc.integer({ min: 1, max: 9000 }), (w, h) => {
        const inside = w >= MIN_DIMENSION && h >= MIN_DIMENSION && w <= MAX_DIMENSION && h <= MAX_DIMENSION;
        if (inside) expect(validateImage(pngHeader(w, h))).toMatchObject({ width: w, height: h, mime: "image/png" });
        else expect(() => validateImage(pngHeader(w, h))).toThrow(ImageValidationError);
      }),
      { seed: 2, numRuns: 500 },
    );
  });
  it("ImageValidationError is a named Error", () => {
    const e = new ImageValidationError("m");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ImageValidationError");
  });
});

function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

describe("listing image keys", () => {
  const uuid = fc.uuid({ version: 4 });
  it("PROPERTY: valid UUID pairs build a key that validates and round-trips; case is normalised", () => {
    fc.assert(
      fc.property(uuid, uuid, fc.constantFrom("jpg", "png", "webp"), (a, b, ext) => {
        const k = listingImageKey(a.toUpperCase(), b, ext);
        expect(k).toBe(`listings/${a.toLowerCase()}/${b.toLowerCase()}.${ext}`);
        expect(isValidListingImageKey(k)).toBe(true);
      }),
      opts,
    );
  });
  it("PROPERTY: filename-ish or traversal ids/extensions are rejected", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    fc.assert(
      fc.property(fc.string().filter((s) => !/^[0-9a-fA-F-]{36}$/.test(s)), (bad) => {
        expect(() => listingImageKey(bad, a, "png")).toThrow("invalid listing image key");
        expect(() => listingImageKey(a, bad, "png")).toThrow();
      }),
      opts,
    );
    for (const ext of ["svg", "gif", "PNG", "png/../x", "", "jpg\n", "avif"]) expect(() => listingImageKey(a, a, ext), ext).toThrow();
  });
  it.each(["../x.jpg", "listings/x/y.jpg", "listings/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111.jpg/", "listings/11111111-1111-4111-8111-111111111111/../11111111-1111-4111-8111-111111111111.jpg", "listings/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111.jpg\n", " listings/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111.jpg"])(
    "isValidListingImageKey(%j) is false",
    (k) => expect(isValidListingImageKey(k)).toBe(false),
  );
});
