import path from "node:path";
import { resolve } from "node:path";
import type { MediaBucket } from "./keys";
import { S3MediaStore } from "./s3";
import { AzureMediaStore, GcsMediaStore } from "./stubs";
import { LocalMediaStore, findMonorepoRoot, type MediaStore } from "./store";

/**
 * Two logical buckets:
 *   private — originals, pending/rejected images, template drafts. Never publicly listable; read via our authenticated
 *             routes or short-lived signed URLs.
 *   public  — approved derivatives only (variants), fronted by a CDN / R2 custom domain (MEDIA_PUBLIC_BASE_URL).
 *
 * Env: MEDIA_DRIVER=local|r2|s3|azure|gcs (default local)
 *   local: MEDIA_DIR (default .data/media; public bucket = <MEDIA_DIR>/_public)
 *   r2/s3: MEDIA_BUCKET (public), MEDIA_PRIVATE_BUCKET, MEDIA_ENDPOINT (r2: https://<account>.r2.cloudflarestorage.com),
 *          MEDIA_REGION (r2: "auto"), MEDIA_ACCESS_KEY_ID, MEDIA_SECRET_ACCESS_KEY, MEDIA_PUBLIC_BASE_URL
 */
const cache = new Map<string, MediaStore>();
const override: Partial<Record<MediaBucket, MediaStore>> = {};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for MEDIA_DRIVER=${process.env.MEDIA_DRIVER}`);
  return v;
}

function build(driver: string, bucket: MediaBucket): MediaStore {
  switch (driver) {
    case "local": {
      const dir = process.env.MEDIA_DIR || ".data/media";
      const root = path.isAbsolute(dir) ? dir : resolve(findMonorepoRoot(), dir);
      return new LocalMediaStore(bucket === "public" ? path.join(root, "_public") : root, bucket);
    }
    case "r2":
    case "s3": {
      const isR2 = driver === "r2";
      return new S3MediaStore({
        driver: driver,
        kind: bucket,
        bucket: bucket === "public" ? required("MEDIA_BUCKET") : required("MEDIA_PRIVATE_BUCKET"),
        endpoint: process.env.MEDIA_ENDPOINT || undefined,
        region: process.env.MEDIA_REGION || (isR2 ? "auto" : required("MEDIA_REGION")),
        accessKeyId: required("MEDIA_ACCESS_KEY_ID"),
        secretAccessKey: required("MEDIA_SECRET_ACCESS_KEY"),
        publicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || undefined,
      });
    }
    case "azure":
      return new AzureMediaStore(bucket);
    case "gcs":
      return new GcsMediaStore(bucket);
    default:
      throw new Error(`Unknown MEDIA_DRIVER "${driver}"`);
  }
}

/** Store for a logical bucket (default "private" so existing callers keep working). Driver chosen by MEDIA_DRIVER. */
export function getMediaStore(bucket: MediaBucket = "private"): MediaStore {
  const o = override[bucket];
  if (o) return o;
  const driver = process.env.MEDIA_DRIVER ?? "local";
  const k = `${driver}:${bucket}`;
  let s = cache.get(k);
  if (!s) cache.set(k, (s = build(driver, bucket)));
  return s;
}

export const getPublicMediaStore = (): MediaStore => getMediaStore("public");

/** Test hook: pin a store (private by default; pass "public" for the public bucket). Undefined clears everything. */
export function setMediaStore(store: MediaStore | undefined, bucket: MediaBucket = "private"): void {
  if (!store) {
    delete override.private;
    delete override.public;
    cache.clear();
    return;
  }
  override[bucket] = store;
}
