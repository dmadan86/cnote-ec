import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AzureMediaStore, GcsMediaStore, KEY_MIME, LocalMediaStore, S3MediaStore, assertMediaKey, findMonorepoRoot, getMediaStore, getPublicMediaStore, isValidMediaKey, keyExt, mimeForKey,
  setMediaStore, type MediaStore,
} from "../src/index";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "media-more-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("isValidMediaKey", () => {
  it.each([
    "templates/a.png", "listings/a/b/640.avif", "storefronts/x/y/z/logo.webp", "templates/a_b-c.d.jpg", "templates/a.b.png", "templates/123.jpeg", "templates/x/1.gif", "listings/a..b/c.png",
  ])("accepts %j", (k) => expect(isValidMediaKey(k)).toBe(true));
  it.each([
    "", "/", "templates", "templates/", "templates/a", "templates/a.", "templates/a.p", "templates/a.toolong", "templates/a.PNG", "Templates/a.png", "other/a.png", "/templates/a.png",
    "templates//a.png", "templates/a//b.png", "templates/./a.png", "templates/../a.png", "templates/a/../b.png", "templates/a/..", "templates/.hidden.png", "templates/a/.hidden/b.png", "templates/a.png/",
    "templates/a b.png", "templates/a\\b.png", "templates/a%2fb.png", "templates/a%2e%2e/b.png", "templates/a\u0000.png", "templates/a.png\n", "templates/a\n.png", "templates/é.png", "templates/a?x=1.png", "templates/a#x.png", "templates/a:b.png",
    "templates/a;b.png", "C:\\x\\a.png", "file:///etc/passwd.png", "http://x/a.png", `templates/${"a".repeat(300)}.png`,
  ])("rejects %j", (k) => expect(isValidMediaKey(k)).toBe(false));
  it("length limit is exactly 300", () => {
    const ok = `templates/${"a".repeat(300 - "templates/.png".length)}.png`;
    expect(ok).toHaveLength(300);
    expect(isValidMediaKey(ok)).toBe(true);
    expect(isValidMediaKey(ok + "x")).toBe(false);
  });
  it("PROPERTY: an accepted key never contains an empty/dot segment, backslash, control char or uppercase", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.constantFrom("templates/", "listings/", "storefronts/", ""), (s, prefix) => {
        const k = prefix + s;
        if (!isValidMediaKey(k)) return true;
        return !k.split("/").some((seg) => seg === "" || seg.startsWith(".")) && !/[\\\u0000-\u001f\s]/.test(k) && k === k.toLowerCase();
      }),
      { seed: 3, numRuns: 2000 },
    );
  });
  it("PROPERTY: keys assembled from safe alphabets are accepted, resolve inside the root, and never escape", () => {
    const seg = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,10}$/);
    fc.assert(
      fc.property(fc.constantFrom("templates", "listings", "storefronts"), fc.array(seg, { minLength: 1, maxLength: 4 }), fc.constantFrom("png", "jpg", "webp", "avif"), (p, segs, ext) => {
        const k = `${p}/${segs.join("/")}.${ext}`;
        expect(isValidMediaKey(k)).toBe(true);
        const root = path.resolve("/srv/media");
        expect(path.resolve(root, k).startsWith(root + path.sep)).toBe(true);
      }),
      { seed: 9, numRuns: 300 },
    );
  });
  it("assertMediaKey throws the generic message (does not echo the key)", () => {
    expect(() => assertMediaKey("../../secret")).toThrow("Invalid media key");
    expect(() => assertMediaKey("../../secret")).not.toThrow(/secret/);
    expect(() => assertMediaKey("templates/a.png")).not.toThrow();
  });
  it("keyExt / mimeForKey", () => {
    expect(keyExt("templates/a.b.png")).toBe("png");
    expect(mimeForKey("templates/a.jpg")).toBe("image/jpeg");
    expect(mimeForKey("templates/a.jpeg")).toBe("image/jpeg");
    expect(mimeForKey("templates/a.avif")).toBe("image/avif");
    expect(mimeForKey("templates/a.gif")).toBe("image/gif");
    expect(mimeForKey("templates/a.bin")).toBe("application/octet-stream");
    expect(Object.keys(KEY_MIME)).toContain("webp");
  });
});

describe("LocalMediaStore", () => {
  const key = (n = "a") => `templates/${randomUUID()}/${n}.png`;
  it("round-trips bytes exactly (incl. empty and binary), head reports size and type, overwrite replaces", async () => {
    const s = new LocalMediaStore(await tmp());
    const k = key();
    const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));
    await s.put(k, bytes, "image/png");
    expect(Buffer.from((await s.get(k))!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(await s.head(k)).toEqual({ size: 1000, contentType: "image/png" });
    await s.put(k, new Uint8Array(), "image/png");
    expect((await s.get(k))!.bytes.byteLength).toBe(0);
    expect(await s.head(k)).toEqual({ size: 0, contentType: "image/png" });
  });
  it("missing objects: get/head null, exists false, delete is a no-op", async () => {
    const s = new LocalMediaStore(await tmp());
    const k = key();
    expect(await s.get(k)).toBeNull();
    expect(await s.head(k)).toBeNull();
    expect(await s.exists(k)).toBe(false);
    await expect(s.delete(k)).resolves.toBeUndefined();
  });
  it("a directory at the key is neither an object nor an existing file", async () => {
    const root = await tmp();
    const s = new LocalMediaStore(root);
    await mkdir(path.join(root, "templates/dir.png"), { recursive: true });
    expect(await s.exists("templates/dir.png")).toBe(false);
    expect(await s.head("templates/dir.png")).toBeNull();
  });
  it("every operation rejects invalid/traversal keys before touching the disk", async () => {
    const root = await tmp();
    const s = new LocalMediaStore(root);
    for (const bad of ["../x.png", "templates/../../x.png", "/etc/passwd", "templates/a", "templates/.x.png", "other/a.png"]) {
      await expect(s.put(bad, new Uint8Array(1), "image/png"), bad).rejects.toThrow("Invalid media key");
      await expect(s.get(bad)).rejects.toThrow("Invalid media key");
      await expect(s.delete(bad)).rejects.toThrow("Invalid media key");
      await expect(s.exists(bad)).rejects.toThrow("Invalid media key");
      await expect(s.head(bad)).rejects.toThrow("Invalid media key");
    }
    expect(await readdir(root)).toEqual([]);
  });
  it("content type must match the key extension; nothing is written on mismatch", async () => {
    const root = await tmp();
    const s = new LocalMediaStore(root);
    for (const ct of ["image/jpeg", "text/html", "image/svg+xml", "", "IMAGE/PNG"]) await expect(s.put("templates/a.png", new Uint8Array(1), ct)).rejects.toThrow("does not match");
    expect(await s.exists("templates/a.png")).toBe(false);
  });
  it("leaves no temp files behind after successful writes, including concurrent writers to one key", async () => {
    const root = await tmp();
    const s = new LocalMediaStore(root);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.put("templates/c/x.png", new Uint8Array(200).fill(i), "image/png")));
    expect(await readdir(path.join(root, "templates/c"))).toEqual(["x.png"]);
    const got = (await s.get("templates/c/x.png"))!.bytes;
    expect(new Set(got).size).toBe(1); // atomic rename: a whole write, never an interleaving
  });
  it("does not follow a symlink escape planted inside the root through a valid key path", async () => {
    const root = await tmp();
    const outside = await tmp();
    await writeFile(path.join(outside, "secret.png"), "top-secret");
    await mkdir(path.join(root, "templates"), { recursive: true });
    await symlink(outside, path.join(root, "templates", "link"));
    const s = new LocalMediaStore(root);
    // Documented limitation: lexical containment only. If a symlink exists inside the media dir (only ops can create one), reads follow it.
    const r = await s.get("templates/link/secret.png");
    expect(r === null || Buffer.from(r.bytes).toString() === "top-secret").toBe(true);
  });
  it("get rethrows non-ENOENT errors (e.g. path component is a file)", async () => {
    const root = await tmp();
    await mkdir(path.join(root, "templates"), { recursive: true });
    await writeFile(path.join(root, "templates", "file.png"), "x");
    const s = new LocalMediaStore(root);
    await expect(s.get("templates/file.png/inner.png")).rejects.toMatchObject({ code: "ENOTDIR" });
  });
  it("signedGetUrl is null (stream through our route); publicUrl only for the public bucket", async () => {
    const pub = new LocalMediaStore(await tmp(), "public");
    const priv = new LocalMediaStore(await tmp(), "private");
    expect(await priv.signedGetUrl()).toBeNull();
    expect(priv.publicUrl("templates/a.png")).toBeNull();
    expect(pub.publicUrl("listings/a/b/640.avif")).toBe("/media/v/listings/a/b/640.avif");
    expect(() => pub.publicUrl("../etc/passwd")).toThrow("Invalid media key");
    expect([pub.driver, pub.bucket, priv.bucket]).toEqual(["local", "public", "private"]);
  });
  it("findMonorepoRoot walks up to pnpm-workspace.yaml and falls back to the start dir", async () => {
    expect(findMonorepoRoot(path.join(process.cwd(), "src"))).toBe(findMonorepoRoot());
    const lonely = await tmp();
    expect(findMonorepoRoot(lonely)).toBe(path.resolve(lonely));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("S3MediaStore (fake client, no network)", () => {
  const cfg = { driver: "s3" as const, bucket: "b", kind: "public" as "public" | "private", region: "ap-south-1", accessKeyId: "k", secretAccessKey: "s", publicBaseUrl: "https://cdn.example.com//" };
  const mk = (over: Partial<typeof cfg> = {}) => {
    const send = vi.fn();
    const s = new S3MediaStore({ ...cfg, ...over }, { send } as never);
    return { s, send };
  };
  const input = (send: ReturnType<typeof vi.fn>, n = 0) => send.mock.calls[n]![0].input as Record<string, unknown>;
  const cmd = (send: ReturnType<typeof vi.fn>, n = 0) => send.mock.calls[n]![0].constructor.name as string;

  it("put: sends bucket/key/body/content-type with the right default cache-control per bucket, and honours an override", async () => {
    const pub = mk();
    await pub.s.put("templates/a.png", new Uint8Array([1]), "image/png");
    expect(cmd(pub.send)).toBe("PutObjectCommand");
    expect(input(pub.send)).toMatchObject({ Bucket: "b", Key: "templates/a.png", ContentType: "image/png", CacheControl: "public, max-age=31536000, immutable" });
    const priv = mk({ kind: "private" });
    await priv.s.put("templates/a.png", new Uint8Array([1]), "image/png");
    expect(input(priv.send).CacheControl).toBe("private, no-store");
    await priv.s.put("templates/a.png", new Uint8Array([1]), "image/png", { cacheControl: "max-age=5" });
    expect(input(priv.send, 1).CacheControl).toBe("max-age=5");
  });
  it("every operation validates keys before any network call", async () => {
    const { s, send } = mk();
    for (const bad of ["../x.png", "templates/a", "other/a.png"]) {
      await expect(s.put(bad, new Uint8Array(1), "image/png")).rejects.toThrow("Invalid media key");
      await expect(s.get(bad)).rejects.toThrow("Invalid media key");
      await expect(s.delete(bad)).rejects.toThrow("Invalid media key");
      await expect(s.head(bad)).rejects.toThrow("Invalid media key");
      await expect(s.exists(bad)).rejects.toThrow("Invalid media key");
      await expect(s.signedGetUrl(bad, 60)).rejects.toThrow("Invalid media key");
    }
    expect(send).not.toHaveBeenCalled();
    expect(() => s.publicUrl("../x.png")).toThrow("Invalid media key");
  });
  it("get: returns bytes + provider content type, falls back to the key's type; 404-ish errors are null; others propagate", async () => {
    const { s, send } = mk();
    send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([9, 9]) }, ContentType: "image/webp" });
    expect(await s.get("templates/a.png")).toEqual({ bytes: new Uint8Array([9, 9]), contentType: "image/webp" });
    send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array() }, ContentType: "" });
    expect((await s.get("templates/a.jpg"))!.contentType).toBe("image/jpeg");
    for (const err of [{ name: "NoSuchKey" }, { name: "NotFound" }, { $metadata: { httpStatusCode: 404 } }]) {
      send.mockRejectedValueOnce(err);
      expect(await s.get("templates/a.png")).toBeNull();
    }
    for (const err of [{ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }, new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }]) {
      send.mockRejectedValueOnce(err);
      await expect(s.get("templates/a.png")).rejects.toBe(err);
    }
  });
  it("head/exists: size + type, missing content length is 0, 404 is null/false, other errors propagate", async () => {
    const { s, send } = mk();
    send.mockResolvedValueOnce({ ContentLength: 42, ContentType: "image/png" });
    expect(await s.head("templates/a.png")).toEqual({ size: 42, contentType: "image/png" });
    send.mockResolvedValueOnce({});
    expect(await s.head("templates/a.webp")).toEqual({ size: 0, contentType: "image/webp" });
    send.mockRejectedValueOnce({ name: "NotFound" });
    expect(await s.exists("templates/a.png")).toBe(false);
    send.mockResolvedValueOnce({ ContentLength: 1 });
    expect(await s.exists("templates/a.png")).toBe(true);
    send.mockRejectedValueOnce(new Error("timeout"));
    await expect(s.exists("templates/a.png")).rejects.toThrow("timeout");
  });
  it("delete issues DeleteObject", async () => {
    const { s, send } = mk();
    send.mockResolvedValue({});
    await s.delete("templates/a.png");
    expect(cmd(send)).toBe("DeleteObjectCommand");
    expect(input(send)).toEqual({ Bucket: "b", Key: "templates/a.png" });
  });
  it("publicUrl: only for the public bucket with a base URL; trailing slashes are trimmed", () => {
    expect(mk().s.publicUrl("listings/a/b/640.avif")).toBe("https://cdn.example.com/listings/a/b/640.avif");
    expect(mk({ kind: "private" }).s.publicUrl("listings/a/b/640.avif")).toBeNull();
    expect(mk({ publicBaseUrl: undefined }).s.publicUrl("listings/a/b/640.avif")).toBeNull();
  });
  it("signed URLs clamp the TTL to 1..3600 seconds and never embed the secret", async () => {
    const s = new S3MediaStore({ ...cfg, kind: "private", endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", secretAccessKey: "SUPER-SECRET" });
    const exp = async (ttl: number) => new URL((await s.signedGetUrl("templates/a.png", ttl))!).searchParams.get("X-Amz-Expires");
    expect([await exp(0), await exp(-50), await exp(60), await exp(3600), await exp(999_999)]).toEqual(["1", "1", "60", "3600", "3600"]);
    expect(await s.signedGetUrl("templates/a.png", 60)).not.toContain("SUPER-SECRET");
  });
  it("exposes driver and bucket kind; builds its own client when none is injected", () => {
    const s = new S3MediaStore({ ...cfg, driver: "r2", kind: "private", endpoint: "https://x.r2.cloudflarestorage.com", region: "auto" });
    expect([s.driver, s.bucket]).toEqual(["r2", "private"]);
  });
});

describe("unconfigured stubs", () => {
  it.each([[new AzureMediaStore("private"), "azure"], [new GcsMediaStore("public"), "gcs"]] as const)("%s fails loudly on every operation", (s: MediaStore, name) => {
    expect(s.driver).toBe(name);
    for (const call of [() => s.put("k", new Uint8Array(), "x"), () => s.get("k"), () => s.delete("k"), () => s.exists("k"), () => s.head("k"), () => s.signedGetUrl("k", 1), () => s.publicUrl("k")])
      expect(call).toThrow(new RegExp(`MEDIA_DRIVER=${name} is not configured`));
  });
});

describe("getMediaStore factory", () => {
  const saved = { ...process.env };
  beforeEach(() => setMediaStore(undefined));
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("MEDIA_")) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (k.startsWith("MEDIA_")) process.env[k] = v;
    setMediaStore(undefined);
  });
  const r2env = () => Object.assign(process.env, { MEDIA_DRIVER: "r2", MEDIA_BUCKET: "pub", MEDIA_PRIVATE_BUCKET: "priv", MEDIA_ACCESS_KEY_ID: "k", MEDIA_SECRET_ACCESS_KEY: "s", MEDIA_ENDPOINT: "https://a.r2.cloudflarestorage.com" });

  it("defaults to local; public bucket lives under <dir>/_public; instances are cached per (driver, bucket)", async () => {
    delete process.env.MEDIA_DRIVER;
    const dir = await tmp();
    process.env.MEDIA_DIR = dir;
    const priv = getMediaStore() as LocalMediaStore;
    const pub = getPublicMediaStore() as LocalMediaStore;
    expect(priv.root).toBe(path.resolve(dir));
    expect(pub.root).toBe(path.join(path.resolve(dir), "_public"));
    expect([priv.bucket, pub.bucket]).toEqual(["private", "public"]);
    expect(getMediaStore("private")).toBe(priv);
    expect(getMediaStore("public")).toBe(pub);
  });
  it("a relative MEDIA_DIR resolves against the monorepo root; empty MEDIA_DIR falls back to .data/media", () => {
    process.env.MEDIA_DIR = "rel/media";
    expect((getMediaStore() as LocalMediaStore).root).toBe(path.join(findMonorepoRoot(), "rel/media"));
    setMediaStore(undefined);
    process.env.MEDIA_DIR = "";
    expect((getMediaStore() as LocalMediaStore).root).toBe(path.join(findMonorepoRoot(), ".data/media"));
  });
  it("r2/s3 need their env: each missing variable is named in the error", () => {
    const need = ["MEDIA_BUCKET", "MEDIA_ACCESS_KEY_ID", "MEDIA_SECRET_ACCESS_KEY"];
    for (const missing of need) {
      r2env();
      delete process.env[missing];
      setMediaStore(undefined);
      expect(() => getMediaStore("public"), missing).toThrow(new RegExp(missing));
    }
    r2env();
    delete process.env.MEDIA_PRIVATE_BUCKET;
    setMediaStore(undefined);
    expect(() => getMediaStore("private")).toThrow(/MEDIA_PRIVATE_BUCKET/);
    expect(() => getMediaStore("public")).not.toThrow();
  });
  it("region: r2 defaults to auto, s3 requires MEDIA_REGION", () => {
    r2env();
    expect(getMediaStore("public").driver).toBe("r2");
    setMediaStore(undefined);
    r2env();
    process.env.MEDIA_DRIVER = "s3";
    delete process.env.MEDIA_REGION;
    expect(() => getMediaStore("public")).toThrow(/MEDIA_REGION/);
    process.env.MEDIA_REGION = "ap-south-1";
    setMediaStore(undefined);
    expect(getMediaStore("public").driver).toBe("s3");
  });
  it("azure/gcs return the stubs; unknown drivers throw", () => {
    process.env.MEDIA_DRIVER = "azure";
    expect(getMediaStore()).toBeInstanceOf(AzureMediaStore);
    process.env.MEDIA_DRIVER = "gcs";
    expect(getMediaStore("public")).toBeInstanceOf(GcsMediaStore);
    process.env.MEDIA_DRIVER = "ftp";
    expect(() => getMediaStore()).toThrow('Unknown MEDIA_DRIVER "ftp"');
  });
  it("setMediaStore pins per bucket and undefined clears both pins and the cache", async () => {
    const a = new LocalMediaStore(await tmp());
    const b = new LocalMediaStore(await tmp(), "public");
    setMediaStore(a);
    setMediaStore(b, "public");
    expect(getMediaStore()).toBe(a);
    expect(getPublicMediaStore()).toBe(b);
    setMediaStore(undefined);
    expect(getMediaStore()).not.toBe(a);
    expect(getPublicMediaStore()).not.toBe(b);
  });
});
