"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Mic, Square, Upload } from "lucide-react";
import { Alert, Button } from "@cnote/ui";
import { draftDestination, postDraft } from "./upload";

const MAX_SECONDS = 300; // 5 minutes
const SOFT_SECONDS = 30; // speech-to-text answers fastest and most reliably on short notes
const MAX_BYTES = 10 * 1024 * 1024;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

const subscribeNone = () => () => {};
const recordingSupported = () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow the microphone in your browser settings, or upload a voice note instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device. You can upload a voice note instead.";
  if (name === "NotReadableError") return "The microphone is being used by another app. Close it and try again.";
  return "We could not start recording. You can upload a voice note instead.";
}

export function VoiceDraftPanel({ mode, language }: { mode: "onboarding" | "portal"; language: string }) {
  const router = useRouter();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const canRecord = useSyncExternalStore(subscribeNone, recordingSupported, () => false);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const previewUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);

  useEffect(() => cleanup, []);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function cleanup() {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  async function start() {
    setError(null);
    setBlob(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      const r = new MediaRecorder(s, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        cleanup();
        setRecording(false);
        const out = new Blob(chunks.current, { type: r.mimeType || mimeType || "audio/webm" });
        if (out.size > MAX_BYTES) setError("That recording is too long. Keep it under 5 minutes.");
        else if (out.size === 0) setError("Nothing was recorded. Please try again.");
        else setBlob(out);
      };
      r.onerror = () => { cleanup(); setRecording(false); setError("Recording stopped unexpectedly. Please try again."); };
      rec.current = r;
      r.start(1000);
      started.current = Date.now();
      setSeconds(0);
      setRecording(true);
      tick.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started.current) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) stop();
      }, 250);
    } catch (e) {
      cleanup();
      setError(micError(e));
    }
  }

  function stop() {
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  }

  function pickFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (!f.type.startsWith("audio/")) return setError("Choose an audio file (mp3, m4a, wav, ogg or webm).");
    if (f.size > MAX_BYTES) return setError("The file is larger than 10 MB.");
    setBlob(f);
  }

  async function submit() {
    if (!blob) return;
    setError(null);
    setBusy(true);
    setProgress(0);
    const r = await postDraft(`/api/ai-draft/voice?language=${encodeURIComponent(language)}`, blob, setProgress, blob.type || "audio/webm");
    setProgress(null);
    if (r.listingId) {
      router.push(draftDestination(mode, r.listingId));
      router.refresh();
      return;
    }
    setBusy(false);
    setError(r.error ?? "Something went wrong.");
  }

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface p-4" aria-labelledby="voice-draft-h">
      <div>
        <h2 id="voice-draft-h" className="text-base font-semibold text-ink">Describe by voice</h2>
        <p className="mt-1 text-sm text-muted">Say what you sell, the size or grade, minimum order and price, in Hindi, Hinglish or English. About 30 seconds is plenty. The recording is deleted after it is transcribed unless you allowed voice retention in Settings.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canRecord ? (
          recording ? (
            <Button type="button" variant="danger" className="min-h-11" onClick={stop} icon={<Square className="size-4" aria-hidden />}>Stop recording</Button>
          ) : (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={start} icon={<Mic className="size-4" aria-hidden />}>{blob ? "Record again" : "Start recording"}</Button>
          )
        ) : null}
        <label className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-line px-3 text-sm font-medium text-ink hover:bg-brand-50 focus-within:outline-2 focus-within:outline-brand-600 ${busy || recording ? "pointer-events-none opacity-50" : ""}`}>
          <Upload className="size-4" aria-hidden />
          Upload a voice note
          <input type="file" accept="audio/*" className="sr-only" disabled={busy || recording} onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {recording ? (
          <span role="timer" aria-live="off" className={`font-mono text-lg tabular-nums ${seconds > SOFT_SECONDS ? "text-warning-700" : "text-ink"}`}>
            <span className="mr-2 inline-block size-2.5 animate-pulse rounded-full bg-red-600 align-middle" aria-hidden />
            {fmt(seconds)} / {fmt(MAX_SECONDS)}
          </span>
        ) : null}
      </div>
      {!canRecord ? <p className="text-sm text-muted">Recording is not available in this browser. Upload a voice note instead (for example one recorded on your phone).</p> : null}
      {recording && seconds > SOFT_SECONDS ? <p className="text-sm text-muted">Longer notes take more time to transcribe. Stop whenever you have said the key details.</p> : null}
      {blob && previewUrl ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">Listen back before sending</p>
          <audio controls src={previewUrl} className="w-full" />
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div role="status" aria-live="polite" className="text-sm text-muted">{progress !== null ? (progress < 100 ? `Uploading ${progress}%…` : "Listening to your note and drafting…") : null}</div>
      <Button type="button" size="lg" className="min-h-11" disabled={!blob || busy || recording} aria-busy={busy} onClick={submit}>
        {busy ? "Drafting…" : "Draft my listing from voice"}
      </Button>
    </section>
  );
}
