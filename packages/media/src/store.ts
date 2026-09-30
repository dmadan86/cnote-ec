import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { KEY_MIME, assertMediaKey, keyExt, type MediaBucket } from "./keys";

export interface MediaObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface MediaHead {
  size: number;
  contentType: string;
}

export interface PutOptions {
  /** Defaults to "public, max-age=31536000, immutable" for the public bucket and "private, no-store" for the private one. */
  cacheControl?: string;
}

/**
 * Object storage port. One instance = one logical bucket (see getMediaStore). Every driver (local disk, R2, S3,
 * Azure Blob, GCS) implements exactly this surface, so switching provider is configuration only.
 */
export interface MediaStore {
  readonly driver: string;
  readonly bucket: MediaBucket;
  put(key: string, bytes: Uint8Array, contentType: string, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  head(key: string): Promise<MediaHead | null>;
  /** Short-lived direct URL for a private object, or null when the driver cannot sign (local): stream via our route instead. */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string | null>;
  /**
   * Stable, cacheable URL for an object in the PUBLIC bucket (CDN / R2 custom domain). Local driver returns a
   * same-origin `/media/v/<key>` path served by apps/web. Null for private stores or when no public base is configured.
   */
  publicUrl(key: string): string | null;
}

/** Walk up from `start` to the pnpm workspace root (three apps run from different cwd's). */
export function findMonorepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * Local-disk driver. Keys are validated against a strict pattern (no traversal possible). Content type is derived
 * from the extension and must match what the caller declares. The public bucket lives in `<MEDIA_DIR>/_public`.
 */
export class LocalMediaStore implements MediaStore {
  readonly driver = "local";
  readonly root: string;
  constructor(dir: string, readonly bucket: MediaBucket = "private") {
    this.root = resolve(dir);
  }
  private file(key: string): string {
    assertMediaKey(key, this.bucket);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid media key");
    return p;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const p = this.file(key);
    // Compare the base MIME type: parameters such as `; charset=utf-8` don't change what the object is.
    if (KEY_MIME[keyExt(key)] !== contentType.split(";")[0]!.trim()) throw new Error("Content type does not match key extension");
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p);
  }
  async get(key: string): Promise<MediaObject | null> {
    const p = this.file(key);
    try {
      const buf = await readFile(p);
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), contentType: KEY_MIME[keyExt(key)]! };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
  async exists(key: string): Promise<boolean> {
    return stat(this.file(key)).then((s) => s.isFile(), () => false);
  }
  async head(key: string): Promise<MediaHead | null> {
    return stat(this.file(key)).then((s) => (s.isFile() ? { size: s.size, contentType: KEY_MIME[keyExt(key)]! } : null), () => null);
  }
  async signedGetUrl(): Promise<string | null> {
    return null;
  }
  publicUrl(key: string): string | null {
    if (this.bucket !== "public") return null;
    assertMediaKey(key, this.bucket);
    return `/media/v/${key}`;
  }
}
