import { DomainError } from "@cnote/core";
import { transcribe } from "@cnote/ai";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { asLang, fail, limited, NO_STORE, tooLarge } from "@/features/search/api-guard";

// Voice search (ADR-004, ADR-010). Audio is personal data: it is read into memory, sent to the ASR provider through
// @cnote/ai `transcribe` (which audits only a hash + size, and the redacted transcript), and DROPPED. Nothing is written to
// disk, object storage or any table by this route. The client must send `consent=1` after showing the notice.
export const dynamic = "force-dynamic";

/** A spoken search query is a few seconds; this is generous for ~20 s of opus/AAC and far below the library's 10 MB cap. */
export const MAX_VOICE_BYTES = 1_500_000;
const LIMIT = { count: 12, windowSeconds: 60 };

export async function POST(req: NextRequest) {
  const blocked = await limited(req, "voice", LIMIT.count, LIMIT.windowSeconds);
  if (blocked) return blocked;
  if (tooLarge(req, MAX_VOICE_BYTES + 20_000)) return fail(413, "too_large");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "bad_request");
  }
  if (form.get("consent") !== "1") return fail(400, "consent_required");
  const file = form.get("audio");
  if (!(file instanceof File) || file.size === 0) return fail(400, "no_audio");
  if (file.size > MAX_VOICE_BYTES) return fail(413, "too_large");
  const lang = asLang(form.get("lang"));

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await transcribe({ audio: { bytes, mimeType: file.type || "audio/webm" }, languageHint: lang }, { type: "voice_note", id: randomUUID() });
    const text = r.text.replace(/\s+/g, " ").trim().slice(0, 200);
    return NextResponse.json({ text, language: r.language, confidence: r.confidence }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof DomainError && err.code === "validation") return fail(400, "invalid_audio");
    console.error("[web] /api/search/voice failed:", err instanceof Error ? err.message : err);
    return fail(502, "transcription_failed");
  }
}
