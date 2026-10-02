// Server side of file uploads (security audit: lower the global server-action body limit).
//
// Server actions share ONE body limit per app (`experimental.serverActions.bodySizeLimit`), and any page route accepts an action POST, so
// a limit sized for evidence/attachment uploads (tens of MB) is a pre-auth memory knob for the whole site. The apps now keep that limit
// at 2 MB and send file-bearing forms to dedicated route handlers built on `readBoundedFormData`, each with its own cap.
import { DomainError } from "@cnote/core";
import { assertSameOrigin } from "@cnote/security";

/** Default total cap for a multi-file form (RFQ attachments, dispute evidence): fits 5 x 10 MB files only if each is under ~5 MB, so callers pass their own. */
export const UPLOAD_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
const tooLarge = (max: number) => new DomainError("validation", `The upload is too large. Attach at most ${mb(max)} in total.`);

/**
 * Parses a multipart/form-data request body while enforcing `maxBytes` on the bytes actually received (not just the Content-Length header,
 * which a client can understate). Rejects cross-site POSTs. Throws DomainError("validation" | "forbidden").
 */
export async function readBoundedFormData(req: Request, maxBytes: number): Promise<FormData> {
  assertSameOrigin(req);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) throw new DomainError("validation", "Expected a form upload.");
  const declared = Number(req.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) throw new DomainError("validation", "The upload size was not declared.");
  if (declared > maxBytes) throw tooLarge(maxBytes);
  if (!req.body) throw new DomainError("validation", "Expected a form upload.");
  let seen = 0;
  const limited = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(tooLarge(maxBytes));
        else controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Request(req.url, { method: "POST", headers: req.headers, body: limited, duplex: "half" } as RequestInit).formData();
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("validation", "The upload could not be read.");
  }
}
