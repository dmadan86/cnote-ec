import { prisma } from "@cnote/db";
import { LocalMediaStore, setMediaStore, solidJpeg, type MediaStore } from "@cnote/media";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_ASSET_BYTES, deleteTemplateAsset, listTemplateAssets, readTemplateAsset, resolveAssetUrls, templateAssetCdnUrl, uploadTemplateAsset } from "../src/assets";

let dir = "";
let store: LocalMediaStore;
const created: string[] = [];

// Template assets are validated from their headers (no decoding), so crafted headers are enough to exercise the rules.
const png = async (w = 20, h = 10) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpg = () => solidJpeg(30, 30);
const webp = async () => {
  const b = new Uint8Array(30);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, 29, 0, 0, 29, 0, 0]);
  return b;
};
const gif = (w: number, h: number) => new Uint8Array([...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3b]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tpl-assets-"));
  store = new LocalMediaStore(dir, "public");
  setMediaStore(store, "public");
});
afterAll(async () => {
  setMediaStore(undefined);
  if (created.length) await prisma.templateAsset.deleteMany({ where: { id: { in: created } } });
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

const upload = async (b: Uint8Array, o?: Parameters<typeof uploadTemplateAsset>[1]) => {
  const a = await uploadTemplateAsset(b, o);
  created.push(a.id);
  return a;
};
const files = async () => (await readdir(path.join(dir, "templates")).catch(() => [] as string[])).sort();

describe("uploadTemplateAsset", () => {
  it("stores each supported format under templates/<uuid>.<ext> with the SNIFFED type and correct metadata", async () => {
    for (const [bytes, mime, ext, w, h] of [[await png(20, 10), "image/png", "png", 20, 10], [await jpg(), "image/jpeg", "jpg", 30, 30], [await webp(), "image/webp", "webp", 30, 30], [gif(7, 5), "image/gif", "gif", 7, 5]] as const) {
      const a = await upload(bytes, { altText: "alt", uploadedBy: null });
      expect(a).toMatchObject({ mimeType: mime, bytes: bytes.length, width: w, height: h, altText: "alt", url: `/media/template-assets/${a.id}` });
      const row = await prisma.templateAsset.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.storageKey).toBe(`templates/${a.id}.${ext}`);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      const back = await readTemplateAsset(a.id);
      expect(back!.contentType).toBe(mime);
      expect(Buffer.from(back!.bytes).equals(Buffer.from(bytes))).toBe(true);
      expect(back!.sha256).toBe(row.sha256);
    }
  });
  it("rejects empty, oversize, non-image, SVG, HTML, corrupt and over-dimension files with validation errors and stores nothing", async () => {
    const before = await files();
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script></svg>`);
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const bad: [Uint8Array, RegExp][] = [
      [new Uint8Array(), /empty/],
      [new Uint8Array(MAX_ASSET_BYTES + 1), /larger than 2 MB/],
      [svg, /Only JPEG, PNG, WebP or GIF/],
      [html, /Only JPEG/],
      [new Uint8Array([1, 2, 3, 4]), /Only JPEG/],
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2]), /corrupt/],
      [(await png()).subarray(0, 20), /corrupt/],
      [gif(0, 0), /corrupt/],
      [gif(6001, 10), /at most 6000/],
      [await png(6001, 2), /at most 6000/],
      [await png(2, 6001), /at most 6000/],
    ];
    for (const [b, re] of bad) await expect(uploadTemplateAsset(b), String(re)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(re) });
    expect(await files()).toEqual(before);
  });
  it("the size limit is inclusive", async () => {
    const big = new Uint8Array(MAX_ASSET_BYTES);
    big.set(await png());
    const a = await upload(big);
    expect(a.bytes).toBe(MAX_ASSET_BYTES);
  });
  it("alt text is truncated to 300 chars and blank becomes null", async () => {
    const a = await upload(await png(), { altText: "x".repeat(400) });
    expect(a.altText).toHaveLength(300);
    expect((await upload(await png(), { altText: "" })).altText).toBeNull();
    expect((await upload(await png())).altText).toBeNull();
  });
  it("cleans up the stored object when the database insert fails", async () => {
    const before = await files();
    vi.spyOn(prisma.templateAsset, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(uploadTemplateAsset(await png())).rejects.toThrow("db down");
    expect(await files()).toEqual(before);
  });
  it("stores with the immutable public cache header", async () => {
    const put = vi.spyOn(store, "put");
    await upload(await png());
    expect((put.mock.calls[0] as unknown[])[3]).toEqual({ cacheControl: "public, max-age=31536000, immutable" });
    expect(put.mock.calls[0]![2]).toBe("image/png");
  });
});

describe("readTemplateAsset / templateAssetCdnUrl", () => {
  it("returns null for malformed ids, unknown ids, missing objects and tampered storage keys", async () => {
    for (const bad of ["", "x", "../../etc/passwd", "123e4567-e89b-12d3-a456-42661417400", `${randomUUID()}/x`, "%2e%2e"]) expect(await readTemplateAsset(bad), bad).toBeNull();
    expect(await readTemplateAsset(randomUUID())).toBeNull();
    const a = await upload(await png());
    await store.delete(`templates/${a.id}.png`);
    expect(await readTemplateAsset(a.id)).toBeNull();
    const b = await upload(await png());
    await prisma.templateAsset.update({ where: { id: b.id }, data: { storageKey: "listings/x/y.png" } });
    expect(await readTemplateAsset(b.id)).toBeNull();
  });
  it("ids are case-insensitive", async () => {
    const a = await upload(await png());
    expect(await readTemplateAsset(a.id.toUpperCase())).not.toBeNull();
  });
  it("CDN url: null for the local driver; the store's public URL for a remote driver; null for bad ids/keys", async () => {
    const a = await upload(await png());
    expect(await templateAssetCdnUrl(a.id)).toBeNull();
    expect(await templateAssetCdnUrl("nope")).toBeNull();
    const remote = { driver: "r2", bucket: "public", publicUrl: (k: string) => `https://cdn.example.com/${k}`, put: store.put.bind(store), get: store.get.bind(store), delete: store.delete.bind(store), exists: store.exists.bind(store), head: store.head.bind(store), signedGetUrl: async () => null } as unknown as MediaStore;
    setMediaStore(remote, "public");
    try {
      expect(await templateAssetCdnUrl(a.id)).toBe(`https://cdn.example.com/templates/${a.id}.png`);
      expect(await templateAssetCdnUrl(randomUUID())).toBeNull();
      await prisma.templateAsset.update({ where: { id: a.id }, data: { storageKey: "../evil.png" } });
      expect(await templateAssetCdnUrl(a.id)).toBeNull();
    } finally {
      setMediaStore(store, "public");
    }
  });
});

describe("listTemplateAssets / deleteTemplateAsset", () => {
  it("lists newest first with inUse, honours the limit", async () => {
    const a = await upload(await png());
    const b = await upload(await png());
    const list = await listTemplateAssets(500);
    expect(list.findIndex((x) => x.id === b.id)).toBeGreaterThanOrEqual(0);
    expect(list.findIndex((x) => x.id === b.id)).toBeLessThan(list.findIndex((x) => x.id === a.id));
    expect(list.every((x) => typeof x.inUse === "boolean")).toBe(true);
    expect(await listTemplateAssets(2)).toHaveLength(2);
    expect(await listTemplateAssets(1)).toHaveLength(1);
  });
  it("refuses to delete assets referenced by a template body, a layout header/footer or a layout theme; deletes unreferenced ones (row + object)", async () => {
    const tpl = await prisma.messageTemplate.create({ data: { key: `test.assetref_${randomUUID().slice(0, 8)}`, channel: "sms", locale: "en", name: "n" } });
    const lay = await prisma.messageLayout.create({ data: { key: `test-assetref-${randomUUID().slice(0, 8)}`, name: "n" } });
    const inBody = await upload(await png());
    const inHeader = await upload(await png());
    const inFooter = await upload(await png());
    const inTheme = await upload(await png());
    const free = await upload(await png());
    try {
      await prisma.messageTemplateVersion.create({ data: { templateId: tpl.id, version: 1, body: `<img src="/media/template-assets/${inBody.id}">`, status: "archived" } });
      await prisma.messageLayoutVersion.create({ data: { layoutId: lay.id, version: 1, headerHtml: `<img src="/media/template-assets/${inHeader.id}">`, footerHtml: "f", status: "archived" } });
      await prisma.messageLayoutVersion.create({ data: { layoutId: lay.id, version: 2, headerHtml: "h", footerHtml: `<img src="/media/template-assets/${inFooter.id}">`, status: "archived" } });
      await prisma.messageLayoutVersion.create({ data: { layoutId: lay.id, version: 3, headerHtml: "h", footerHtml: "f", theme: { logoAssetId: inTheme.id }, status: "archived" } });
      for (const a of [inBody, inHeader, inFooter, inTheme]) {
        await expect(deleteTemplateAsset(a.id), a.id).rejects.toMatchObject({ code: "conflict" });
        expect(await readTemplateAsset(a.id)).not.toBeNull();
      }
      const listed = await listTemplateAssets(500);
      for (const a of [inBody, inHeader, inFooter, inTheme]) expect(listed.find((x) => x.id === a.id)!.inUse).toBe(true);
      expect(listed.find((x) => x.id === free.id)!.inUse).toBe(false);
      await deleteTemplateAsset(free.id);
      expect(await prisma.templateAsset.findUnique({ where: { id: free.id } })).toBeNull();
      expect(await store.exists(`templates/${free.id}.png`)).toBe(false);
      await expect(deleteTemplateAsset(free.id)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await prisma.messageTemplateVersion.deleteMany({ where: { templateId: tpl.id } });
      await prisma.messageLayoutVersion.deleteMany({ where: { layoutId: lay.id } });
      await prisma.messageTemplate.delete({ where: { id: tpl.id } });
      await prisma.messageLayout.delete({ where: { id: lay.id } });
    }
  });
});

describe("resolveAssetUrls", () => {
  const OLD = process.env.APP_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = OLD;
  });
  it("returns the html untouched when there are no asset references", async () => {
    const html = `<img src="https://a.com/x.png"><a href="/media/template-assets/x">l</a>`;
    expect(await resolveAssetUrls(html, "absolute")).toBe(html);
    expect(await resolveAssetUrls(html, "inline")).toBe(html);
  });
  it("absolute mode prefixes APP_URL for every occurrence, leaves other srcs alone", async () => {
    process.env.APP_URL = "https://app.example.in/";
    const id1 = randomUUID();
    const id2 = randomUUID();
    const out = await resolveAssetUrls(`<img src="/media/template-assets/${id1}"><img src="/media/template-assets/${id1}"><img src="/media/template-assets/${id2}"><img src="https://x.com/a.png">`, "absolute");
    expect(out).toBe(`<img src="https://app.example.in/media/template-assets/${id1}"><img src="https://app.example.in/media/template-assets/${id1}"><img src="https://app.example.in/media/template-assets/${id2}"><img src="https://x.com/a.png">`);
  });
  it("inline mode embeds real assets as data: URIs (correct type + bytes) and falls back to an absolute URL for unknown ones", async () => {
    process.env.APP_URL = "https://app.example.in";
    const a = await upload(await png(12, 12));
    const missing = randomUUID();
    const out = await resolveAssetUrls(`<img src="/media/template-assets/${a.id}"><img src="/media/template-assets/${missing}">`, "inline");
    const m = out.match(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
    expect(m).not.toBeNull();
    const back = await readTemplateAsset(a.id);
    expect(Buffer.from(m![1]!, "base64").equals(Buffer.from(back!.bytes))).toBe(true);
    expect(out).toContain(`src="https://app.example.in/media/template-assets/${missing}"`);
  });
  it("only rewrites well-formed asset paths in src attributes (no path traversal; other attributes untouched)", async () => {
    process.env.APP_URL = "https://app.example.in";
    const html = `<a href="/media/template-assets/${randomUUID()}"><img src="/media/template-assets/../../etc/passwd"><img alt="/media/template-assets/${randomUUID()}">`;
    expect(await resolveAssetUrls(html, "absolute")).toBe(html);
  });
});
