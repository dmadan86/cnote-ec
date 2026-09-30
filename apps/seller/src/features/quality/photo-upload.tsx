"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Camera, ImagePlus, Video, X } from "lucide-react";
import { Alert, Button } from "@cnote/ui";
import { VideoFrameError, extractFrames, type VideoLimits } from "./video-frames";

const MAX_BYTES = 5 * 1024 * 1024;

/** Re-fetches the server component while an analysis is queued or running. */
export function PendingRefresh() {
  const t = useTranslations("quality");
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [router]);
  return <p className="text-sm text-muted" role="status" aria-live="polite">{t("pendingRefresh")}</p>;
}

export function PhotoUpload({ orderId, maxPhotos, video }: { orderId: string; maxPhotos: number; video: VideoLimits }) {
  const t = useTranslations("quality");
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "video": the selected files are frames sampled in this browser from one short clip (the clip itself is never uploaded)
  const [mode, setMode] = useState<"photos" | "video">("photos");
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  // blob: object URLs of the seller's own files only (never a string that could carry markup or javascript:)
  const previews = useMemo(() => files.map((f) => safeBlobUrl(URL.createObjectURL(f))), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(list: FileList | null) {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError(t("errors.format")); continue; }
      if (f.size > MAX_BYTES) { setError(t("errors.tooLarge", { name: f.name || t("errors.aPhoto") })); continue; }
      if (next.length >= maxPhotos) { setError(t("errors.maxPhotos", { max: maxPhotos })); break; }
      next.push(f);
    }
    setFiles(next);
    if (camera.current) camera.current.value = "";
    if (gallery.current) gallery.current.value = "";
  }

  async function addVideo(list: FileList | null) {
    const file = list?.[0];
    if (videoInput.current) videoInput.current.value = "";
    if (!file) return;
    setError(null); setNote(null); setReading(true);
    try {
      const frames = await extractFrames(file, video);
      setFiles(frames); setMode("video");
      setNote(t("video.picked", { count: frames.length }));
    } catch (e) {
      const code = e instanceof VideoFrameError ? e.code : "unreadable";
      setError(t(`video.errors.${code}`, { mb: Math.round(video.maxBytes / 1024 / 1024), seconds: video.maxSeconds }));
    } finally {
      setReading(false);
    }
  }

  function clearVideo() { setFiles([]); setMode("photos"); setNote(null); setError(null); }

  async function submit() {
    if (!files.length) return setError(t("errors.addOne"));
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f, f.name));
      if (mode === "video") form.append("source", "video");
      const res = await fetch(`/api/quality/${orderId}`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error && body.error !== "internal" ? body.error : t("errors.shareFailed"));
      setFiles([]); setMode("photos"); setNote(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" id="quality-camera" aria-label={t("takePhoto")} onChange={(e) => add(e.target.files)} />
        <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" id="quality-gallery" aria-label={t("choosePhotos")} onChange={(e) => add(e.target.files)} />
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || reading || mode === "video" || files.length >= maxPhotos} onClick={() => camera.current?.click()} icon={<Camera className="size-4" aria-hidden />}>{t("takePhoto")}</Button>
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || reading || mode === "video" || files.length >= maxPhotos} onClick={() => gallery.current?.click()} icon={<ImagePlus className="size-4" aria-hidden />}>{t("choosePhotos")}</Button>
        <input ref={videoInput} type="file" accept="video/mp4,video/quicktime,video/webm" className="sr-only" id="quality-video" aria-label={t("video.choose")} aria-describedby="quality-video-help" onChange={(e) => void addVideo(e.target.files)} />
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || reading || files.length > 0} onClick={() => videoInput.current?.click()} icon={<Video className="size-4" aria-hidden />}>{t("video.choose")}</Button>
      </div>
      <p id="quality-video-help" className="text-xs text-muted">{t("video.help", { seconds: video.maxSeconds, mb: Math.round(video.maxBytes / 1024 / 1024), min: video.minFrames, max: video.maxFrames })}</p>
      <div role="status" aria-live="polite" className="text-sm text-muted">{reading ? t("video.extracting") : note}</div>
      {mode === "video" && files.length ? <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={clearVideo}>{t("video.removeVideo")}</Button> : null}
      {files.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={mode === "video" ? t("video.selectedFrames") : t("selectedPhotos")}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="relative overflow-hidden rounded-md border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
              <img src={previews[i]} alt={mode === "video" ? t("video.frameAlt", { n: i + 1 }) : t("photoAlt", { n: i + 1, name: f.name })} className="aspect-square w-full object-cover" />
              {mode === "photos" ? <button type="button" disabled={busy} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid size-9 place-items-center rounded-full bg-ink/70 text-white focus-visible:outline-2 focus-visible:outline-brand-600" aria-label={t("removePhoto", { n: i + 1 })}>
                <X className="size-4" aria-hidden />
              </button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" className="min-h-11" onClick={submit} disabled={busy || !files.length} aria-busy={busy}>{busy ? t("sharing") : t("share")}</Button>
      <p className="text-xs text-muted">{t("privacy")}</p>
    </div>
  );
}

function safeBlobUrl(u: string): string {
  return u.startsWith("blob:") ? u : "";
}
