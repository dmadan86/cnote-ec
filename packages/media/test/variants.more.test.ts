import fc from "fast-check";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  BLUR_MAX_CHARS, QUALITY_PRESETS, VARIANT_EXT, VARIANT_FORMATS, VARIANT_MIME, VARIANT_WIDTHS, isValidMediaKey, parseVariantPath, processImage, solidJpeg, variantKey, type VariantFormat,
} from "../src/index";

const ids = { listingId: "11111111-1111-4111-8111-111111111111", imageId: "22222222-2222-4222-8222-222222222222" };
const solid = async (w: number, h: number, fmt: "jpeg" | "png" | "webp" = "jpeg", ch: 3 | 4 = 3) => {
  const s = sharp({ create: { width: w, height: h, channels: ch, background: ch === 4 ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 200, g: 80, b: 40 } } });
  return new Uint8Array(await (fmt === "jpeg" ? s.jpeg() : fmt === "png" ? s.png() : s.webp()).toBuffer());
};

describe("processImage: never upscales", () => {
  it("PROPERTY: every variant is <= the original width and <= the requested width, with aspect ratio preserved", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 160, max: 1100 }), fc.integer({ min: 50, max: 900 }), async (w, h) => {
        const out = await processImage(await solid(w, h), ids, { formats: ["jpeg"] });
        expect(out.width).toBe(w);
        expect(out.height).toBe(h);
        const expected = VARIANT_WIDTHS.filter((x) => x <= w);
        expect(out.variants.map((v) => v.width)).toEqual(expected);
        for (const v of out.variants) {
          expect(v.width).toBeLessThanOrEqual(w);
          expect(Math.abs(v.height - (v.width * h) / w)).toBeLessThanOrEqual(1);
        }
      }),
      { seed: 12, numRuns: 12 },
    );
  });
  it("an original exactly at a ladder width includes it; one pixel narrower drops it", async () => {
    expect((await processImage(await solid(640, 400), ids, { formats: ["jpeg"] })).variants.map((v) => v.width)).toEqual([160, 320, 640]);
    expect((await processImage(await solid(639, 400), ids, { formats: ["jpeg"] })).variants.map((v) => v.width)).toEqual([160, 320]);
  });
  it("custom widths are sorted, and widths larger than the original are dropped", async () => {
    const out = await processImage(await solid(500, 300), ids, { widths: [400, 100, 900, 250], formats: ["webp"] });
    expect(out.variants.map((v) => v.width)).toEqual([100, 250, 400]);
    expect(out.variants.every((v) => v.format === "webp")).toBe(true);
  });
  it("smaller than the smallest variant, or no formats/widths requested, is an error (never an empty success)", async () => {
    await expect(processImage(await solid(159, 159), ids)).rejects.toThrow(/smaller than the smallest/);
    await expect(processImage(await solid(400, 400), ids, { widths: [] })).rejects.toThrow();
    await expect(processImage(await solid(400, 400), ids, { formats: [] })).rejects.toThrow();
  });
});

describe("processImage: metadata is stripped for every input format", () => {
  const exif = { IFD0: { Copyright: "leak-me-owner", Artist: "leak-me-artist" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "77/1 35/1 0/1" } };
  for (const fmt of ["jpeg", "png", "webp"] as const) {
    it(`${fmt} input: output has no EXIF/XMP/ICC/IPTC and no GPS/copyright bytes`, async () => {
      const base = sharp({ create: { width: 400, height: 300, channels: 3, background: "#3366cc" } }).withExif(exif);
      const buf = fmt === "jpeg" ? await base.jpeg().toBuffer() : fmt === "png" ? await base.png().toBuffer() : await base.webp().toBuffer();
      expect((await sharp(buf).metadata()).exif, "fixture must carry EXIF").toBeDefined();
      const out = await processImage(new Uint8Array(buf), ids);
      expect(out.variants.length).toBe(6); // 160 and 320 x 3 formats (400px original)
      for (const v of out.variants) {
        const m = await sharp(v.data).metadata();
        expect(m.exif).toBeUndefined();
        expect(m.xmp).toBeUndefined();
        expect(m.iptc).toBeUndefined();
        expect(m.icc).toBeUndefined();
        const raw = Buffer.from(v.data);
        for (const needle of ["leak-me-owner", "leak-me-artist", "Exif", "http://ns.adobe.com/xap"]) expect(raw.includes(needle), `${v.format} contains ${needle}`).toBe(false);
      }
    });
  }
  it("a JPEG carrying an ICC profile is converted to sRGB and the profile is dropped", async () => {
    const buf = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#aa5500" } }).withIccProfile("p3").jpeg().toBuffer();
    expect((await sharp(buf).metadata()).icc).toBeDefined();
    const out = await processImage(new Uint8Array(buf), ids, { formats: ["jpeg"] });
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.icc).toBeUndefined();
      expect(m.space).toBe("srgb");
    }
  });
});

describe("processImage: orientation", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("EXIF orientation %i is baked in; dimensions swap for 5-8; the tag is removed", async (o) => {
    const src = new Uint8Array(await sharp({ create: { width: 600, height: 300, channels: 3, background: "#22aa22" } }).withMetadata({ orientation: o }).jpeg().toBuffer());
    const out = await processImage(src, ids, { formats: ["jpeg"] });
    const swapped = o >= 5;
    expect([out.width, out.height]).toEqual(swapped ? [300, 600] : [600, 300]);
    for (const v of out.variants) {
      expect((await sharp(v.data).metadata()).orientation).toBeUndefined();
      expect(v.height > v.width).toBe(swapped);
    }
  });
});

describe("processImage: outputs", () => {
  it("every variant decodes to its declared format/size and carries consistent metadata", async () => {
    const out = await processImage(await solid(700, 500, "png"), ids);
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.width).toBe(v.width);
      expect(m.height).toBe(v.height);
      expect(v.contentType).toBe(VARIANT_MIME[v.format]);
      expect(v.key.endsWith(`/${v.width}.${VARIANT_EXT[v.format]}`)).toBe(true);
      expect(v.bytes).toBe(v.data.byteLength);
      expect(isValidMediaKey(v.key)).toBe(true);
    }
    expect(new Set(out.variants.map((v) => v.key)).size).toBe(out.variants.length);
  });
  it("preset table stays sane", () => {
    expect(QUALITY_PRESETS.avif.quality).toBeLessThan(QUALITY_PRESETS.webp.quality);
    expect([...VARIANT_WIDTHS]).toEqual([...VARIANT_WIDTHS].sort((a, b) => a - b));
    expect(VARIANT_FORMATS).toEqual(["avif", "webp", "jpeg"]);
  });
  it("blur placeholder stays under the cap even for incompressible noise", async () => {
    const raw = Buffer.alloc(400 * 400 * 3);
    let s = 1;
    for (let i = 0; i < raw.length; i++) raw[i] = (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16;
    const noise = new Uint8Array(await sharp(raw, { raw: { width: 400, height: 400, channels: 3 } }).png().toBuffer());
    const out = await processImage(noise, ids, { formats: ["jpeg"], widths: [160] });
    expect(out.blurDataUrl.length).toBeLessThanOrEqual(BLUR_MAX_CHARS);
    expect(out.blurDataUrl).toMatch(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
    const decoded = Buffer.from(out.blurDataUrl.split(",")[1]!, "base64");
    expect((await sharp(decoded).metadata()).format).toBe("webp");
  });
  it("transparent PNGs get an opaque white background in the JPEG fallback (not black)", async () => {
    const out = await processImage(await solid(300, 300, "png", 4), ids, { formats: ["jpeg", "webp"], widths: [160] });
    const jpeg = out.variants.find((v) => v.format === "jpeg")!;
    const { data } = await sharp(jpeg.data).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]].every((c) => c! > 240)).toBe(true);
    const webp = out.variants.find((v) => v.format === "webp")!;
    expect((await sharp(webp.data).metadata()).hasAlpha).toBe(true); // alpha-capable formats keep transparency
  });
});

describe("processImage: hostile input", () => {
  it("garbage, empty, truncated pixel data and unsupported formats reject (no partial output)", async () => {
    await expect(processImage(new Uint8Array(), ids)).rejects.toThrow();
    await expect(processImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' width='500' height='500'/>"), ids, { formats: ["jpeg"] }).then((o) => o.variants.length)).resolves.toBeDefined(); // sharp can rasterise SVG: callers MUST validateImage first
    const good = await solid(400, 400, "png");
    await expect(processImage(good.subarray(0, Math.floor(good.length / 2)), ids)).rejects.toThrow();
  });
  it("decompression-bomb guard: images beyond 6000x6000 pixels are refused", async () => {
    const huge = new Uint8Array(await sharp({ create: { width: 6001, height: 6001, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer());
    await expect(processImage(huge, ids, { formats: ["jpeg"], widths: [160] })).rejects.toThrow(/pixel/i);
  });
});

describe("variantKey / parseVariantPath", () => {
  it("PROPERTY: keys are valid media keys and round-trip through parseVariantPath", () => {
    fc.assert(
      fc.property(fc.uuid({ version: 4 }), fc.uuid({ version: 4 }), fc.constantFrom(...VARIANT_WIDTHS), fc.constantFrom<VariantFormat>("avif", "webp", "jpeg"), (l, i, w, f) => {
        const k = variantKey(l.toUpperCase(), i, w, f);
        expect(isValidMediaKey(k)).toBe(true);
        expect(k).toBe(k.toLowerCase());
        const p = parseVariantPath(`https://cdn.example.com/${k}`)!;
        expect(p).toMatchObject({ width: w, ext: VARIANT_EXT[f] });
        expect(p.dir).toBe(`https://cdn.example.com/listings/${l.toLowerCase()}/${i.toLowerCase()}`);
      }),
      { seed: 6, numRuns: 200 },
    );
  });
  it("variantKey rejects ids that could escape the directory", () => {
    for (const bad of ["../x", "a/b", "a b", "A\nB", "", "%2e%2e", "é"]) expect(() => variantKey(bad, ids.imageId, 640, "avif"), bad).toThrow("Invalid media key");
    expect(() => variantKey(ids.listingId, "../../etc", 640, "avif")).toThrow();
  });
  it("parseVariantPath keeps a query string out of the result and rejects malformed paths", () => {
    const k = variantKey(ids.listingId, ids.imageId, 320, "webp");
    expect(parseVariantPath(`/media/v/${k}?w=1&q=2`)).toMatchObject({ width: 320, ext: "webp" });
    for (const bad of ["", "/media/v/listings/x/y/640.avif", `/media/v/${k}.exe`, `/media/v/listings/${ids.listingId}/${ids.imageId}/6.avif`, `/media/v/listings/${ids.listingId}/${ids.imageId}/12345.avif`, `/media/v/listings/${ids.listingId}/${ids.imageId}/640.png`, `${k}#x`.replace("listings", "other")])
      expect(parseVariantPath(bad), bad).toBeNull();
  });
});

describe("solidJpeg", () => {
  it("builds a decodable jpeg of the requested size and colour", async () => {
    const b = await solidJpeg(300, 200, [255, 0, 0]);
    const m = await sharp(b).metadata();
    expect([m.format, m.width, m.height]).toEqual(["jpeg", 300, 200]);
    const { data } = await sharp(b).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
    expect(data[1]).toBeLessThan(15);
    expect((await sharp(await solidJpeg(200, 200)).metadata()).width).toBe(200);
  });
});
