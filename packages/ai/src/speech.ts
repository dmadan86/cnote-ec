// Speech-to-text (ADR-004): provider port with a Sarvam AI adapter (Indian languages, code-mixed) and a
// deterministic mock for dev/CI. Selected by ASR_PROVIDER=sarvam|mock (default mock).
import { DomainError } from "@cnote/core";
import type { Lang, TranscribeInput, TranscribeOutput } from "./index";
import type { ProviderResult, SpeechToText } from "./types";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_MS = 5 * 60 * 1000;

/** Base MIME type (parameters stripped) → file extension used for the multipart filename. */
export const AUDIO_EXT: Record<string, string> = {
  "audio/ogg": "ogg", "audio/opus": "opus", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/m4a": "m4a",
  "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm",
};
export const baseMime = (m: string) => m.split(";")[0]!.trim().toLowerCase();

export function assertAudio(a: TranscribeInput["audio"]): string {
  const mime = baseMime(a.mimeType);
  if (!AUDIO_EXT[mime]) throw new DomainError("validation", "Audio must be ogg/opus, mp3, m4a/aac, wav or webm");
  if (!a.bytes.length) throw new DomainError("validation", "The recording is empty");
  if (a.bytes.length > MAX_AUDIO_BYTES) throw new DomainError("validation", "Recording is larger than 10 MB");
  return mime;
}

export const MOCK_TRANSCRIPT_PREFIX = "CNOTE-MOCK-TRANSCRIPT:";
export const MOCK_MODEL = "asr-mock";
export const MOCK_PROMPT_VERSION = "asr-mock-v1";

/** Deterministic: audio whose bytes start with "CNOTE-MOCK-TRANSCRIPT:<text>" transcribes to <text>; anything else to "" (confidence 0 → review). */
export class MockSpeechToText implements SpeechToText {
  readonly name = "mock";
  async transcribe(input: TranscribeInput): Promise<ProviderResult<TranscribeOutput>> {
    const raw = new TextDecoder().decode(input.audio.bytes.subarray(0, 4096));
    const text = raw.startsWith(MOCK_TRANSCRIPT_PREFIX) ? raw.slice(MOCK_TRANSCRIPT_PREFIX.length).trim() : "";
    return {
      output: { text, language: input.languageHint ?? "en", confidence: text ? 0.9 : 0, durationMs: 0 },
      confidence: text ? 0.9 : 0, provider: "mock", modelId: MOCK_MODEL, promptVersion: MOCK_PROMPT_VERSION,
    };
  }
}

const BCP47: Record<Lang, string> = { en: "en-IN", hi: "hi-IN", kn: "kn-IN", ta: "ta-IN", te: "te-IN", mr: "mr-IN", gu: "gu-IN", bn: "bn-IN" };

export interface SarvamOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
interface SarvamResponse {
  transcript?: string;
  language_code?: string | null;
  language_probability?: number | null;
  timestamps?: { words?: string[]; start_time_seconds?: number[]; end_time_seconds?: number[] } | null;
}

class Fatal extends Error {}
export const SARVAM_PROMPT_VERSION = "asr-sarvam-v1";

/**
 * Sarvam AI REST speech-to-text: POST {base}/speech-to-text, header `api-subscription-key`, multipart
 * (file, language_code, model?, mode, with_timestamps). NOTE: the synchronous REST endpoint is documented for
 * clips under ~30 s; longer notes need Sarvam's batch API (not implemented; see docs/design/photo-and-voice-listing.md).
 */
export class SarvamSpeechToText implements SpeechToText {
  readonly name = "sarvam";
  private o: Required<Omit<SarvamOptions, "model">> & { model?: string };
  constructor(opts: SarvamOptions) {
    if (!opts.apiKey) throw new Error("SARVAM_API_KEY is required for ASR_PROVIDER=sarvam");
    this.o = {
      baseUrl: "https://api.sarvam.ai", timeoutMs: 30_000, retries: 2, fetch: (...a) => fetch(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...opts,
    };
  }

  private async post(form: () => FormData): Promise<SarvamResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      if (attempt) await this.o.sleep(500 * 2 ** (attempt - 1));
      try {
        const res = await this.o.fetch(`${this.o.baseUrl}/speech-to-text`, {
          method: "POST", headers: { "api-subscription-key": this.o.apiKey }, body: form(), signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        if (res.ok) return (await res.json()) as SarvamResponse;
        const err = new Error(`sarvam stt ${res.status}`);
        if (res.status !== 429 && res.status < 500) throw new Fatal(err.message); // other 4xx will not improve on retry
        lastErr = err;
      } catch (e) {
        if (e instanceof Fatal) throw e;
        lastErr = e; // network error / timeout / 5xx / 429: retry
      }
    }
    throw lastErr as Error;
  }

  async transcribe(input: TranscribeInput): Promise<ProviderResult<TranscribeOutput>> {
    const mime = baseMime(input.audio.mimeType);
    const form = () => {
      const f = new FormData();
      f.append("file", new Blob([input.audio.bytes as BlobPart], { type: mime }), `audio.${AUDIO_EXT[mime] ?? "bin"}`);
      f.append("language_code", input.languageHint ? BCP47[input.languageHint] : "unknown");
      f.append("mode", "transcribe");
      f.append("with_timestamps", "true");
      if (this.o.model) f.append("model", this.o.model);
      return f;
    };
    const r = await this.post(form);
    const text = (r.transcript ?? "").trim();
    const ts = r.timestamps;
    const words = ts?.words ?? [];
    const segments = words.map((w, i) => ({ text: w, startMs: Math.round((ts!.start_time_seconds?.[i] ?? 0) * 1000), endMs: Math.round((ts!.end_time_seconds?.[i] ?? 0) * 1000) }));
    // Sarvam returns no transcript confidence; language-ID probability is the best available signal (capped: it is not WER).
    const confidence = text ? Math.min(0.9, r.language_probability ?? 0.7) : 0;
    const out: TranscribeOutput = {
      text, language: (r.language_code ?? input.languageHint ?? "unknown").split("-")[0]!, confidence,
      durationMs: segments.length ? segments[segments.length - 1]!.endMs : 0,
      ...(segments.length ? { segments } : {}),
    };
    return { output: out, confidence, provider: "sarvam", modelId: this.o.model ?? "sarvam-stt", promptVersion: SARVAM_PROMPT_VERSION };
  }
}

let cached: { name: string; impl: SpeechToText } | null = null;
let override: SpeechToText | null = null;

/** ASR_PROVIDER=sarvam|mock (default mock), read per call. */
export function getSpeechToText(): SpeechToText {
  if (override) return override;
  const name = process.env.ASR_PROVIDER === "sarvam" ? "sarvam" : "mock";
  if (cached?.name !== name) {
    cached = { name, impl: name === "sarvam" ? new SarvamSpeechToText({ apiKey: process.env.SARVAM_API_KEY ?? "", model: process.env.SARVAM_STT_MODEL || undefined }) : new MockSpeechToText() };
  }
  return cached.impl;
}
export function setSpeechToTextForTests(s: SpeechToText | null) { override = s; cached = null; }
