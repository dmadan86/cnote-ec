import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { isValidListingImageKey } from "./image";

export interface MediaObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface MediaStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
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

const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Local-disk driver. Keys are validated against a strict pattern, so no traversal is possible.
 * Content type is derived from the extension (validated at upload time) rather than a sidecar file.
 */
export class LocalMediaStore implements MediaStore {
  readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private file(key: string): string {
    if (!isValidListingImageKey(key)) throw new Error("Invalid media key");
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid media key");
    return p;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const p = this.file(key);
    const ext = key.slice(key.lastIndexOf(".") + 1);
    if (EXT_MIME[ext] !== contentType) throw new Error("Content type does not match key extension");
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p);
  }
  async get(key: string): Promise<MediaObject | null> {
    const p = this.file(key);
    try {
      const buf = await readFile(p);
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), contentType: EXT_MIME[key.slice(key.lastIndexOf(".") + 1)]! };
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
}

/** Stub: S3/R2 arrives with credentials. Selecting it fails loudly at first use, never silently. */
export class S3MediaStore implements MediaStore {
  private fail(): never {
    throw new Error("MEDIA_DRIVER=s3 is not configured yet (S3/R2 credentials and client are pending)");
  }
  put(): Promise<void> { return this.fail(); }
  get(): Promise<MediaObject | null> { return this.fail(); }
  delete(): Promise<void> { return this.fail(); }
  exists(): Promise<boolean> { return this.fail(); }
}

let cached: MediaStore | undefined;

/** Driver from env: MEDIA_DRIVER (local|s3, default local), MEDIA_DIR (default .data/media, relative to the repo root). */
export function getMediaStore(): MediaStore {
  if (cached) return cached;
  const driver = process.env.MEDIA_DRIVER ?? "local";
  if (driver === "s3") return (cached = new S3MediaStore());
  if (driver !== "local") throw new Error(`Unknown MEDIA_DRIVER "${driver}"`);
  const dir = process.env.MEDIA_DIR || ".data/media";
  return (cached = new LocalMediaStore(path.isAbsolute(dir) ? dir : resolve(findMonorepoRoot(), dir)));
}

/** Test hook. */
export function setMediaStore(store: MediaStore | undefined): void {
  cached = store;
}
