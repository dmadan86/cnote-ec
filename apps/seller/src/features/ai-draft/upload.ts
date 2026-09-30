/** Localised messages for transport failures (the caller passes strings from `listings.upload`). */
export interface UploadMessages { network: string; tooLarge: string; failed: string }

export interface DraftResponse { ok?: boolean; listingId?: string; transcript?: string; needsReview?: boolean; skipped?: { filename: string | null; reason: string }[]; error?: string }

/** POST with progress; resolves (never rejects) so callers render one inline error. */
export function postDraft(url: string, body: XMLHttpRequestBodyInit, onProgress: (pct: number) => void, msgs: UploadMessages, contentType?: string): Promise<DraftResponse> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: msgs.network });
    xhr.onload = () => {
      let parsed: DraftResponse = {};
      try {
        parsed = JSON.parse(xhr.responseText) as DraftResponse;
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && parsed.listingId) resolve(parsed);
      else if (xhr.status === 413) resolve({ error: msgs.tooLarge });
      else resolve({ error: parsed.error && parsed.error !== "internal" ? parsed.error : msgs.failed });
    };
    xhr.send(body);
  });
}

export const draftDestination = (mode: "onboarding" | "portal", listingId: string) => (mode === "onboarding" ? "/onboarding" : `/listings/${listingId}/edit`);
