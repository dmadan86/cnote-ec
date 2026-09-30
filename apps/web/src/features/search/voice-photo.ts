// Pure helpers for the voice / photo search controls (kept out of the component so they are unit-testable in node).
import { LANGS, type SearchLang } from "./lang";

/** Container types MediaRecorder can produce that @cnote/ai accepts (ogg/opus, mp4/aac, webm), best first. */
export const RECORDER_MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"] as const;

export function pickRecorderMime(isSupported: (m: string) => boolean): string | undefined {
  return RECORDER_MIME_PREFERENCE.find((m) => {
    try {
      return isSupported(m);
    } catch {
      return false;
    }
  });
}

/** Longest a voice query may run (ms). Sarvam's synchronous endpoint is meant for ~30 s clips; a search is a few seconds. */
export const MAX_VOICE_MS = 15_000;
/** A press held at least this long is "hold to talk" (release stops); a shorter one is "tap to start, tap to stop". */
export const HOLD_MS = 600;

export const isHold = (downAt: number, upAt: number) => upAt - downAt >= HOLD_MS;

/** UI locale -> ASR language hint. Unknown locales fall back to English. */
export function langHint(locale: string): SearchLang {
  return (LANGS as readonly string[]).includes(locale) ? (locale as SearchLang) : "en";
}

/** Target size for the client-side downscale: never upscale, longest edge <= max, at least 1 px. */
export function fitWithin(width: number, height: number, max = 1280): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The /search URL (unlocalised) for a photo result. Category is only added when the server trusted it. */
export function photoSearchHref(r: { query: string; category?: string | null }): string {
  const sp = new URLSearchParams({ q: r.query, via: "photo", tab: "products" });
  if (r.category) sp.set("category", r.category);
  return `/search?${sp.toString()}`;
}
