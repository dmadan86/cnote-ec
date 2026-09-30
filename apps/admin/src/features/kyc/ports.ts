import "server-only";
// Composition root for @cnote/identity KYC ports in the admin app (staff previews + audit report storage).
import { extractDocument } from "@cnote/ai";
import { ImageValidationError, getMediaStore, validateImage } from "@cnote/media";
import { setKycPorts } from "@cnote/identity";

let wired = false;
export function ensureKycPorts(): void {
  if (wired) return;
  setKycPorts({
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
  });
  wired = true;
}
