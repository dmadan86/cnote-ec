import "server-only";
// Composition root for @cnote/identity's KYC ports (identity may not depend on ai/media, ADR-006):
// object store = PRIVATE media bucket, image validation = media, extraction = ai.extractDocument (logged, redacted).
import { extractDocument } from "@cnote/ai";
import { ImageValidationError, getMediaStore, validateImage } from "@cnote/media";
import { setKycPorts, type KycPorts } from "@cnote/identity";

let wired = false;
export function ensureKycPorts(): void {
  if (wired) return;
  const ports: KycPorts = {
    store: {
      put: (k, b, ct) => getMediaStore("private").put(k, b, ct),
      get: (k) => getMediaStore("private").get(k),
      delete: (k) => getMediaStore("private").delete(k),
    },
    inspectImage: (bytes) => {
      try {
        const v = validateImage(bytes);
        return { mime: v.mime, ext: v.ext, width: v.width, height: v.height, sha256: v.sha256 };
      } catch (err) {
        throw err instanceof ImageValidationError ? err : new Error("Invalid image");
      }
    },
    extractDocument: (input, subject) => extractDocument({ image: input.image, docType: input.docType }, subject),
  };
  setKycPorts(ports);
  wired = true;
}
