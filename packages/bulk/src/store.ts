import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path, { dirname, resolve } from "node:path";
import { findMonorepoRoot, getMediaStore } from "@cnote/media";

/**
 * Object storage for bulk files (uploaded sources, exports, error reports). Logical keys look like
 * `bulk/<jobId>/source.zip`.
 *
 * @cnote/media's MediaStore only accepts image content types on the local driver and the key prefixes
 * listings|templates|storefronts, so bulk files cannot go through it as-is. Until it is relaxed:
 *   - MEDIA_DRIVER=local (default): plain files under <MEDIA_DIR>/_bulk/
 *   - r2 / s3: the private MediaStore with the key mapped to `listings/_bulk/<jobId>/...` (S3 accepts any content type)
 */
export interface BulkStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** short-lived direct download URL when the driver can sign (S3/R2); null otherwise */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string | null>;
}

const KEY_RE = /^bulk\/[0-9a-f-]{36}\/[a-z0-9._-]{1,80}$/;
const assertKey = (key: string) => {
  if (!KEY_RE.test(key) || key.includes("..")) throw new Error("Invalid bulk key");
};

class LocalBulkStore implements BulkStore {
  private root(): string {
    const dir = process.env.MEDIA_DIR || ".data/media";
    return path.join(path.isAbsolute(dir) ? dir : resolve(findMonorepoRoot(), dir), "_bulk");
  }
  private file(key: string): string {
    assertKey(key);
    const p = resolve(this.root(), key.slice("bulk/".length));
    if (!p.startsWith(this.root() + path.sep)) throw new Error("Invalid bulk key");
    return p;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.file(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const b = await readFile(this.file(key));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
  async signedGetUrl(): Promise<string | null> {
    return null;
  }
  async exists(key: string): Promise<boolean> {
    return stat(this.file(key)).then((s) => s.isFile(), () => false);
  }
}

class MediaBulkStore implements BulkStore {
  private k(key: string) {
    assertKey(key);
    return `listings/_${key}`; // bulk/<id>/x -> listings/_bulk/<id>/x
  }
  put(key: string, bytes: Uint8Array, contentType: string) {
    return getMediaStore("private").put(this.k(key), bytes, contentType);
  }
  async get(key: string) {
    return (await getMediaStore("private").get(this.k(key)))?.bytes ?? null;
  }
  delete(key: string) {
    return getMediaStore("private").delete(this.k(key));
  }
  signedGetUrl(key: string, ttl: number) {
    return getMediaStore("private").signedGetUrl(this.k(key), ttl);
  }
}

let override: BulkStore | undefined;
/** Test hook. */
export function setBulkStore(store: BulkStore | undefined): void {
  override = store;
}
export function getBulkStore(): BulkStore {
  if (override) return override;
  return (process.env.MEDIA_DRIVER ?? "local") === "local" ? local : remote;
}
const local = new LocalBulkStore();
const remote = new MediaBulkStore();

/** In-memory store for tests. */
export class MemoryBulkStore implements BulkStore {
  readonly files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    assertKey(key);
    this.files.set(key, bytes);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async signedGetUrl() {
    return null;
  }
}
