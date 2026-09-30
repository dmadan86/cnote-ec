import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertMediaKey, mimeForKey, type MediaBucket } from "./keys";
import type { MediaHead, MediaObject, MediaStore, PutOptions } from "./store";

export interface S3StoreConfig {
  driver: "r2" | "s3";
  bucket: string;
  kind: MediaBucket;
  /** R2: https://<account>.r2.cloudflarestorage.com. AWS: omit (SDK resolves from region). MinIO etc.: their URL. */
  endpoint?: string;
  /** R2: "auto". AWS: e.g. "ap-south-1". */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** CDN / R2 custom domain in front of the PUBLIC bucket, e.g. https://img.example.com (no trailing slash). */
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
}

const notFound = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === "NotFound" || x?.name === "NoSuchKey" || x?.$metadata?.httpStatusCode === 404;
};

/** S3 API driver: serves both Cloudflare R2 (endpoint + region "auto") and AWS S3. */
export class S3MediaStore implements MediaStore {
  readonly driver: string;
  readonly bucket: MediaBucket;
  private readonly client: S3Client;
  constructor(private readonly cfg: S3StoreConfig, client?: S3Client) {
    this.driver = cfg.driver;
    this.bucket = cfg.kind;
    this.client =
      client ??
      new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        // R2 rejects the SDK's newer default checksum headers.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }
  async put(key: string, bytes: Uint8Array, contentType: string, opts: PutOptions = {}): Promise<void> {
    assertMediaKey(key, this.bucket);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: opts.cacheControl ?? (this.bucket === "public" ? "public, max-age=31536000, immutable" : "private, no-store"),
      }),
    );
  }
  async get(key: string): Promise<MediaObject | null> {
    assertMediaKey(key, this.bucket);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      const bytes = await r.Body!.transformToByteArray();
      return { bytes, contentType: r.ContentType || mimeForKey(key) };
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    assertMediaKey(key, this.bucket);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key })); // idempotent on S3/R2
  }
  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }
  async head(key: string): Promise<MediaHead | null> {
    assertMediaKey(key, this.bucket);
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType || mimeForKey(key) };
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }
  async signedGetUrl(key: string, ttlSeconds: number): Promise<string | null> {
    assertMediaKey(key, this.bucket);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: Math.max(1, Math.min(ttlSeconds, 3600)) });
  }
  publicUrl(key: string): string | null {
    if (this.bucket !== "public" || !this.cfg.publicBaseUrl) return null;
    assertMediaKey(key, this.bucket);
    return `${this.cfg.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  }
}
