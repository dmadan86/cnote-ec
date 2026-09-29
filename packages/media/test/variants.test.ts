import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { BLUR_MAX_CHARS, isValidMediaKey, processImage, variantKey, parseVariantPath } from "../src/index";

const ids = { listingId: "11111111-1111-4111-8111-111111111111", imageId: "22222222-2222-4222-8222-222222222222" };

async function fixture(w: number, h: number, fmt: "jpeg" | "png" = "jpeg", extra?: (s: Sharp) => Sharp) {
  const base = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  const s = extra ? extra(base) : base;
  return new Uint8Array(await (fmt === "jpeg" ? s.jpeg() : s.png()).toBuffer());
}

describe("processImage", () => {
  it("emits widths <= original in avif/webp/jpeg with deterministic keys and no upscaling", async () => {
    const out = await processImage(await fixture(700, 500), ids);
    expect(new Set(out.variants.map((v) => v.width))).toEqual(new Set([160, 320, 640]));
    expect(out.variants).toHaveLength(9);
    for (const v of out.variants) {
      expect(v.key).toBe(`listings/${ids.listingId}/${ids.imageId}/${v.width}.${v.format === "jpeg" ? "jpg" : v.format}`);
      expect(isValidMediaKey(v.key)).toBe(true);
      expect(v.bytes).toBe(v.data.length);
      const m = await sharp(v.data).metadata();
      expect(m.format).toBe(v.format === "jpeg" ? "jpeg" : v.format === "avif" ? "heif" : "webp");
      expect(m.width).toBe(v.width);
      expect(v.height).toBe(Math.round((v.width * 500) / 700));
    }
    expect(out).toMatchObject({ width: 700, height: 500 });
  });

  it("full ladder for a large original (jpeg only to keep it fast)", async () => {
    const out = await processImage(await fixture(2400, 1200), ids, { formats: ["jpeg"] });
    expect(out.variants.map((v) => v.width)).toEqual([160, 320, 640, 960, 1280, 1920]);
  });

  it("strips EXIF/GPS and ICC", async () => {
    const src = await fixture(400, 300, "jpeg", (s) => s.withExif({ IFD0: { Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 0/1" } }));
    expect((await sharp(src).metadata()).exif).toBeDefined();
    const out = await processImage(src, ids);
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.icc).toBeUndefined();
      expect(Buffer.from(v.data).includes("secret-owner")).toBe(false);
    }
  });

  it("auto-orients (EXIF orientation 6 swaps dimensions)", async () => {
    const src = await fixture(600, 300, "jpeg", (s) => s.withMetadata({ orientation: 6 }));
    const out = await processImage(src, ids, { formats: ["jpeg"] });
    expect(out.width).toBe(300);
    expect(out.height).toBe(600);
    const v = out.variants.find((x) => x.width === 160)!;
    expect(v.height).toBeGreaterThan(v.width);
    expect((await sharp(v.data).metadata()).orientation).toBeUndefined();
  });

  it("blur placeholder is a small webp data url", async () => {
    const out = await processImage(await fixture(400, 400), ids, { formats: ["jpeg"] });
    expect(out.blurDataUrl.startsWith("data:image/webp;base64,")).toBe(true);
    expect(out.blurDataUrl.length).toBeLessThanOrEqual(BLUR_MAX_CHARS);
  });

  it("rejects garbage and undersized input", async () => {
    await expect(processImage(new Uint8Array([1, 2, 3]), ids)).rejects.toThrow();
    await expect(processImage(await fixture(100, 100), ids)).rejects.toThrow(/smaller/);
  });

  it("keys parse back", () => {
    const k = variantKey(ids.listingId, ids.imageId, 640, "avif");
    expect(parseVariantPath(`https://cdn.x/${k}`)).toMatchObject({ width: 640, ext: "avif" });
    expect(parseVariantPath("/media/listing-images/abc")).toBeNull();
  });
});
