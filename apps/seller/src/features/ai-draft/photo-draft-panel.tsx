"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Camera, ImagePlus, Sparkles, X } from "lucide-react";
import { Alert, Button, Field, Textarea } from "@cnote/ui";
import { draftDestination, postDraft } from "./upload";

const MAX_PHOTOS = 4;
const MAX_BYTES = 5 * 1024 * 1024;

export function PhotoDraftPanel({ mode, language }: { mode: "onboarding" | "portal"; language: string }) {
  const t = useTranslations("listings.photo");
  const tu = useTranslations("listings.upload");
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [hint, setHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(list: FileList | null) {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError(t("typeError")); continue; }
      if (f.size > MAX_BYTES) { setError(t("sizeError", { name: f.name || t("aPhoto") })); continue; }
      if (next.length >= MAX_PHOTOS) { setError(t("maxError", { max: MAX_PHOTOS })); break; }
      next.push(f);
    }
    setFiles(next);
    if (camera.current) camera.current.value = "";
    if (gallery.current) gallery.current.value = "";
  }

  async function submit() {
    if (!files.length) return setError(t("needOne"));
    setError(null);
    setBusy(true);
    setProgress(0);
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    form.set("hint", hint);
    form.set("language", language);
    const r = await postDraft("/api/ai-draft/photos", form, setProgress, { network: tu("network"), tooLarge: tu("tooLarge"), failed: tu("failed") });
    setProgress(null);
    if (r.listingId) {
      router.push(draftDestination(mode, r.listingId));
      router.refresh();
      return;
    }
    setBusy(false);
    setError(r.error ?? t("generic"));
  }

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface p-4" aria-labelledby="photo-draft-h">
      <div>
        <h2 id="photo-draft-h" className="text-base font-semibold text-ink">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("intro")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" id="photo-camera" onChange={(e) => add(e.target.files)} />
        <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" id="photo-gallery" onChange={(e) => add(e.target.files)} />
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || files.length >= MAX_PHOTOS} onClick={() => camera.current?.click()} icon={<Camera className="size-4" aria-hidden />}>{t("take")}</Button>
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || files.length >= MAX_PHOTOS} onClick={() => gallery.current?.click()} icon={<ImagePlus className="size-4" aria-hidden />}>{t("choose")}</Button>
      </div>
      {files.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("selected")}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="relative overflow-hidden rounded-md border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
              <img src={previews[i]} alt={t("photoAlt", { n: i + 1, name: f.name })} className="aspect-square w-full object-cover" />
              <button type="button" disabled={busy} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid size-9 place-items-center rounded-full bg-ink/70 text-white focus-visible:outline-2 focus-visible:outline-brand-600" aria-label={t("remove", { n: i + 1 })}>
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Field label={t("hintLabel")} htmlFor="photo-hint" hint={t("hintHint")}>
        <Textarea id="photo-hint" value={hint} maxLength={2000} disabled={busy} onChange={(e) => setHint(e.target.value)} className="min-h-24 text-base" placeholder="500 piece se order, rate 18 rupaye per piece…" />
      </Field>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div role="status" aria-live="polite" className="text-sm text-muted">{progress !== null ? (progress < 100 ? t("uploading", { pct: progress }) : t("analysing")) : null}</div>
      <Button type="button" size="lg" className="min-h-11" disabled={busy || !files.length} aria-busy={busy} onClick={submit} icon={<Sparkles className="size-4" aria-hidden />}>
        {busy ? t("drafting") : t("submit")}
      </Button>
    </section>
  );
}
