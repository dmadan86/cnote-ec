// Client-side video -> frames (docs/design/quality.md). The clip never leaves the browser: 3-6 evenly spaced frames are
// drawn to a canvas, re-encoded as JPEG and uploaded as ordinary photos through the validated server path.

export interface VideoLimits { minFrames: number; maxFrames: number; maxSeconds: number; maxBytes: number }
export type VideoErrorCode = "format" | "tooLarge" | "tooLong" | "unreadable" | "noFrames";
export class VideoFrameError extends Error {
  constructor(readonly code: VideoErrorCode) { super(code); }
}

/** One frame per ~5 s, clamped to [min, max]. */
export function frameCount(durationSec: number, l: Pick<VideoLimits, "minFrames" | "maxFrames">): number {
  return Math.min(l.maxFrames, Math.max(l.minFrames, Math.ceil(durationSec / 5)));
}

/** Evenly spaced sample times at the middle of n equal slices (avoids the black first/last frame). */
export function frameTimes(durationSec: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.min(durationSec, ((i + 0.5) / n) * durationSec));
}

/** Pre-flight checks that need no decoding. */
export function checkVideoFile(f: { type: string; size: number }, l: Pick<VideoLimits, "maxBytes">): void {
  if (!f.type.startsWith("video/")) throw new VideoFrameError("format");
  if (f.size > l.maxBytes) throw new VideoFrameError("tooLarge");
}

const LONG_EDGE = 1568;
const timeout = <T,>(p: Promise<T>, ms: number, code: VideoErrorCode): Promise<T> =>
  new Promise((res, rej) => { const t = setTimeout(() => rej(new VideoFrameError(code)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

const once = (el: HTMLVideoElement, ok: string) =>
  new Promise<void>((res, rej) => {
    const done = () => { el.removeEventListener(ok, onOk); el.removeEventListener("error", onErr); };
    const onOk = () => { done(); res(); };
    const onErr = () => { done(); rej(new VideoFrameError("unreadable")); };
    el.addEventListener(ok, onOk); el.addEventListener("error", onErr);
  });

/** Decodes the clip in an off-DOM <video>, seeks to each sample time and captures a JPEG per frame. */
export async function extractFrames(file: File, limits: VideoLimits): Promise<File[]> {
  checkVideoFile(file, limits);
  const url = URL.createObjectURL(file);
  if (!url.startsWith("blob:")) throw new VideoFrameError("unreadable"); // only object URLs of the chosen file
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto";
  try {
    const loaded = once(video, "loadedmetadata");
    video.src = url;
    await timeout(loaded, 15_000, "unreadable");
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new VideoFrameError("unreadable");
    if (duration > limits.maxSeconds + 0.5) throw new VideoFrameError("tooLong");
    if (!video.videoWidth || !video.videoHeight) throw new VideoFrameError("unreadable");
    const scale = Math.min(1, LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new VideoFrameError("unreadable");
    const base = file.name.replace(/\.[^.]+$/, "") || "video";
    const out: File[] = [];
    for (const [i, at] of frameTimes(duration, frameCount(duration, limits)).entries()) {
      const seeked = once(video, "seeked");
      video.currentTime = at;
      await timeout(seeked, 10_000, "unreadable");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      if (blob) out.push(new File([blob], `${base}-frame-${i + 1}.jpg`, { type: "image/jpeg" }));
    }
    if (out.length < limits.minFrames) throw new VideoFrameError("noFrames");
    return out;
  } finally {
    video.removeAttribute("src"); video.load();
    URL.revokeObjectURL(url);
  }
}
