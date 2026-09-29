import type { MediaBucket } from "./keys";
import type { MediaHead, MediaObject, MediaStore } from "./store";

/**
 * Not-yet-implemented drivers. Selecting one fails loudly at first use (never silently falls back to disk).
 * Implement by mirroring s3.ts against the provider SDK; the MediaStore contract is the only thing callers see.
 */
class UnconfiguredStore implements MediaStore {
  constructor(readonly driver: string, readonly bucket: MediaBucket, private readonly hint: string) {}
  private fail(): never {
    throw new Error(`MEDIA_DRIVER=${this.driver} is not configured: ${this.hint}`);
  }
  put(): Promise<void> { return this.fail(); }
  get(): Promise<MediaObject | null> { return this.fail(); }
  delete(): Promise<void> { return this.fail(); }
  exists(): Promise<boolean> { return this.fail(); }
  head(): Promise<MediaHead | null> { return this.fail(); }
  signedGetUrl(): Promise<string | null> { return this.fail(); }
  publicUrl(): string | null { return this.fail(); }
}

/**
 * Azure Blob Storage (MEDIA_DRIVER=azure) — STUB. Implementation map (SDK: @azure/storage-blob):
 *   MEDIA_BUCKET / MEDIA_PRIVATE_BUCKET  -> container names (public / private)
 *   MEDIA_ACCESS_KEY_ID                  -> storage account name   (StorageSharedKeyCredential accountName)
 *   MEDIA_SECRET_ACCESS_KEY              -> storage account key    (StorageSharedKeyCredential accountKey)
 *   MEDIA_ENDPOINT                       -> https://<account>.blob.core.windows.net
 *   MEDIA_PUBLIC_BASE_URL                -> Front Door / Azure CDN origin for the public container
 *   put -> BlockBlobClient.uploadData (blobHTTPHeaders.blobContentType / blobCacheControl)
 *   get -> BlobClient.download (404 -> null)   delete -> deleteIfExists   exists/head -> getProperties
 *   signedGetUrl -> BlobClient.generateSasUrl({ permissions: "r", expiresOn })
 */
export class AzureMediaStore extends UnconfiguredStore {
  constructor(bucket: MediaBucket) {
    super("azure", bucket, "implement AzureMediaStore with @azure/storage-blob (see mapping in packages/media/src/stubs.ts)");
  }
}

/**
 * Google Cloud Storage (MEDIA_DRIVER=gcs) — STUB. Implementation map (SDK: @google-cloud/storage):
 *   MEDIA_BUCKET / MEDIA_PRIVATE_BUCKET  -> bucket names (public / private)
 *   MEDIA_ACCESS_KEY_ID                  -> service-account client_email
 *   MEDIA_SECRET_ACCESS_KEY              -> service-account private_key (or use ADC and leave both unset)
 *   MEDIA_ENDPOINT                       -> apiEndpoint override (emulators only)
 *   MEDIA_PUBLIC_BASE_URL                -> Cloud CDN / load balancer URL for the public bucket
 *   put -> file.save(bytes, { contentType, metadata: { cacheControl } })
 *   get -> file.download() (404 -> null)   delete -> file.delete({ ignoreNotFound: true })   exists/head -> exists()/getMetadata()
 *   signedGetUrl -> file.getSignedUrl({ version: "v4", action: "read", expires })
 * (GCS also offers an S3-interoperability endpoint: storage.googleapis.com with HMAC keys works with s3.ts as MEDIA_DRIVER=s3.)
 */
export class GcsMediaStore extends UnconfiguredStore {
  constructor(bucket: MediaBucket) {
    super("gcs", bucket, "implement GcsMediaStore with @google-cloud/storage (see mapping in packages/media/src/stubs.ts), or use the S3-interop endpoint with MEDIA_DRIVER=s3");
  }
}
