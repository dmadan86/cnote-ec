import { getMediaStore } from "@cnote/media";

/**
 * Object storage for bulk files (uploaded sources, exports, error reports), keyed `bulk/<jobId>/<file>`.
 * Goes through @cnote/media's PRIVATE bucket on every driver (local disk, R2, S3, …); the media port refuses
 * `bulk/` keys in the public bucket, so sellers' price sheets are never publicly addressable.
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

class MediaBulkStore implements BulkStore {
  put(key: string, bytes: Uint8Array, contentType: string) {
    assertKey(key);
    return getMediaStore("private").put(key, bytes, contentType);
  }
  async get(key: string) {
    assertKey(key);
    return (await getMediaStore("private").get(key))?.bytes ?? null;
  }
  delete(key: string) {
    assertKey(key);
    return getMediaStore("private").delete(key);
  }
  signedGetUrl(key: string, ttl: number) {
    assertKey(key);
    return getMediaStore("private").signedGetUrl(key, ttl);
  }
}

let override: BulkStore | undefined;
/** Test hook. */
export function setBulkStore(store: BulkStore | undefined): void {
  override = store;
}
export function getBulkStore(): BulkStore {
  return override ?? store;
}
const store = new MediaBulkStore();

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
