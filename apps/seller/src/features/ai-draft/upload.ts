export interface DraftResponse { ok?: boolean; listingId?: string; transcript?: string; needsReview?: boolean; skipped?: { filename: string | null; reason: string }[]; error?: string }

/** POST with progress; resolves (never rejects) so callers render one inline error. */
export function postDraft(url: string, body: XMLHttpRequestBodyInit, onProgress: (pct: number) => void, contentType?: string): Promise<DraftResponse> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: "Network problem. Please check your connection and try again." });
    xhr.onload = () => {
      let parsed: DraftResponse = {};
      try {
        parsed = JSON.parse(xhr.responseText) as DraftResponse;
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && parsed.listingId) resolve(parsed);
      else if (xhr.status === 413) resolve({ error: "That upload is too large." });
      else resolve({ error: parsed.error && parsed.error !== "internal" ? parsed.error : "We could not draft your listing. Please try again." });
    };
    xhr.send(body);
  });
}

export const draftDestination = (mode: "onboarding" | "portal", listingId: string) => (mode === "onboarding" ? "/onboarding" : `/listings/${listingId}/edit`);
