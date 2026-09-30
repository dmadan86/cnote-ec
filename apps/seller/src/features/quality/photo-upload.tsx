"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImagePlus, X } from "lucide-react";
import { Alert, Button } from "@cnote/ui";

const MAX_BYTES = 5 * 1024 * 1024;

/** Re-fetches the server component while an analysis is queued or running. */
export function PendingRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [router]);
  return <p className="text-sm text-muted" role="status" aria-live="polite">Analysing your photos. This page updates automatically.</p>;
}

export function PhotoUpload({ orderId, maxPhotos }: { orderId: string; maxPhotos: number }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(list: FileList | null) {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError("Use JPEG, PNG or WebP photos."); continue; }
      if (f.size > MAX_BYTES) { setError(`${f.name || "A photo"} is larger than 5 MB.`); continue; }
      if (next.length >= maxPhotos) { setError(`You can add up to ${maxPhotos} photos.`); break; }
      next.push(f);
    }
    setFiles(next);
    if (camera.current) camera.current.value = "";
    if (gallery.current) gallery.current.value = "";
  }

  async function submit() {
    if (!files.length) return setError("Add at least one photo.");
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f, f.name));
      const res = await fetch(`/api/quality/${orderId}`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error && body.error !== "internal" ? body.error : "We could not share your photos. Please try again.");
      setFiles([]);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" id="quality-camera" aria-label="Take a photo" onChange={(e) => add(e.target.files)} />
        <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" id="quality-gallery" aria-label="Choose photos" onChange={(e) => add(e.target.files)} />
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || files.length >= maxPhotos} onClick={() => camera.current?.click()} icon={<Camera className="size-4" aria-hidden />}>Take a photo</Button>
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || files.length >= maxPhotos} onClick={() => gallery.current?.click()} icon={<ImagePlus className="size-4" aria-hidden />}>Choose photos</Button>
      </div>
      {files.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Selected photos">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="relative overflow-hidden rounded-md border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
              <img src={previews[i]} alt={`Photo ${i + 1}: ${f.name}`} className="aspect-square w-full object-cover" />
              <button type="button" disabled={busy} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid size-9 place-items-center rounded-full bg-ink/70 text-white focus-visible:outline-2 focus-visible:outline-brand-600" aria-label={`Remove photo ${i + 1}`}>
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" className="min-h-11" onClick={submit} disabled={busy || !files.length} aria-busy={busy}>{busy ? "Sharing…" : "Share photos"}</Button>
      <p className="text-xs text-muted">Location and camera details are removed from photos before they are stored. Photos are private and deleted after 6 months.</p>
    </div>
  );
}
