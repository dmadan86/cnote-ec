import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalMediaStore, S3MediaStore, findMonorepoRoot, isValidListingImageKey, listingImageKey, readImageDimensions, sha256Hex, sniffImageMime, validateImage } from "../src/index";

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) => {
  // SOI, APP0 (len 4), SOF0 (len 11)
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  return b;
};
const webpLossy = (w: number, h: number) => {
  const b = new Uint8Array(30);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a]);
  b[26] = w & 255; b[27] = w >> 8; b[28] = h & 255; b[29] = h >> 8;
  return b;
};
const webpLossless = (w: number, h: number) => {
  const b = new Uint8Array(30);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8L"), 0, 0, 0, 0, 0x2f]);
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  new DataView(b.buffer).setUint32(21, bits, true);
  return b;
};
const webpExt = (w: number, h: number) => {
  const b = new Uint8Array(30);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0]);
  b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = ((w - 1) >> 16) & 255;
  b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = ((h - 1) >> 16) & 255;
  return b;
};

describe("sniffImageMime", () => {
  it("detects by magic bytes", () => {
    expect(sniffImageMime(png(1, 1))).toBe("image/png");
    expect(sniffImageMime(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffImageMime(webpLossy(1, 1))).toBe("image/webp");
  });
  it("rejects others", () => {
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns=...>"))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it("png", () => expect(readImageDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 }));
  it("jpeg SOF", () => expect(readImageDimensions(jpeg(1024, 768), "image/jpeg")).toEqual({ width: 1024, height: 768 }));
  it("webp VP8", () => expect(readImageDimensions(webpLossy(800, 600), "image/webp")).toEqual({ width: 800, height: 600 }));
  it("webp VP8L", () => expect(readImageDimensions(webpLossless(801, 601), "image/webp")).toEqual({ width: 801, height: 601 }));
  it("webp VP8X", () => expect(readImageDimensions(webpExt(4000, 3000), "image/webp")).toEqual({ width: 4000, height: 3000 }));
  it("truncated → null", () => {
    expect(readImageDimensions(png(1, 1).slice(0, 20), "image/png")).toBeNull();
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
  });
});

describe("validateImage", () => {
  it("accepts a valid image", () => {
    const v = validateImage(png(640, 480));
    expect(v).toMatchObject({ mime: "image/png", ext: "png", width: 640, height: 480, bytes: 33 });
    expect(v.sha256).toBe(sha256Hex(png(640, 480)));
  });
  it("rejects small, huge, non-image, oversize, empty", () => {
    expect(() => validateImage(png(199, 500))).toThrow(/at least/);
    expect(() => validateImage(png(6001, 500))).toThrow(/at most/);
    expect(() => validateImage(new TextEncoder().encode("hello world, not an image"))).toThrow(/JPEG, PNG or WebP/);
    expect(() => validateImage(new Uint8Array(0))).toThrow(/empty/);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(png(640, 480));
    expect(() => validateImage(big)).toThrow(/5 MB/);
  });
});

describe("keys", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  it("builds and validates", () => {
    expect(listingImageKey(a, b, "png")).toBe(`listings/${a}/${b}.png`);
    expect(isValidListingImageKey(`listings/${a}/${b}.jpg`)).toBe(true);
    expect(isValidListingImageKey(`listings/${a}/../${b}.jpg`)).toBe(false);
    expect(isValidListingImageKey(`listings/${a}/${b}.svg`)).toBe(false);
    expect(() => listingImageKey("../x", b, "png")).toThrow();
  });
});

describe("LocalMediaStore", () => {
  let dir = "";
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const key = `listings/${a}/${b}.png`;
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it("put/get/exists/delete", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-"));
    const s = new LocalMediaStore(dir);
    expect(await s.exists(key)).toBe(false);
    expect(await s.get(key)).toBeNull();
    await s.put(key, png(300, 300), "image/png");
    expect(await s.exists(key)).toBe(true);
    const got = await s.get(key);
    expect(got?.contentType).toBe("image/png");
    expect(Buffer.from(got!.bytes).equals(Buffer.from(png(300, 300)))).toBe(true);
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
    await s.delete(key); // idempotent
  });
  it("blocks traversal and mismatched types", async () => {
    dir = dir || (await mkdtemp(path.join(tmpdir(), "media-")));
    const s = new LocalMediaStore(dir);
    await expect(s.put("../../etc/passwd", png(1, 1), "image/png")).rejects.toThrow(/Invalid/);
    await expect(s.get(`listings/${a}/../../x.png`)).rejects.toThrow(/Invalid/);
    await expect(s.put(key, png(1, 1), "image/jpeg")).rejects.toThrow(/match/);
  });
});

describe("misc", () => {
  it("finds the monorepo root", () => expect(findMonorepoRoot()).toMatch(/cnote$/));
  it("s3 stub throws", async () => { expect(() => new S3MediaStore().put()).toThrow(/not configured/); });
});
