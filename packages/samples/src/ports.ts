// Evaluation photos live in the PRIVATE media bucket under `samples/<sampleId>/<uuid>.<ext>`. A port keeps tests off the disk.
import { getMediaStore } from "@cnote/media";

export interface SamplePhotoStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

const privateStore: SamplePhotoStore = {
  put: (k, b, ct) => getMediaStore("private").put(k, b, ct),
  get: (k) => getMediaStore("private").get(k),
  delete: (k) => getMediaStore("private").delete(k),
};

let store: SamplePhotoStore = privateStore;
/** Override photo storage (tests). Pass null to restore the private bucket. */
export function setSamplePhotoStore(s: SamplePhotoStore | null): void { store = s ?? privateStore; }
export const photoStore = (): SamplePhotoStore => store;

export const photoKey = (sampleId: string, photoId: string, ext: string) => `samples/${sampleId}/${photoId}.${ext}`;
