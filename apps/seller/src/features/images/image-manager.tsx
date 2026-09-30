"use client";
import { useCallback, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, ImagePlus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, Input, type BadgeTone } from "@cnote/ui";
import type { ListingImageView } from "@cnote/catalogue";
import { deleteImageAction, reorderImagesAction, setAltTextAction } from "./actions";

const MAX_IMAGES = 8;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

const STATUS: Record<ListingImageView["status"], { tone: BadgeTone }> = {
  pending: { tone: "warning" },
  flagged: { tone: "warning" },
  approved: { tone: "success" },
  rejected: { tone: "danger" },
};

interface Upload {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/** POST one file with progress (fetch has no upload progress). */
function uploadOne(listingId: string, file: File, onProgress: (p: number) => void, msgs: { network: string; failed: string }): Promise<{ image?: ListingImageView; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/listings/${listingId}/images`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: msgs.network });
    xhr.onload = () => {
      let body: { image?: ListingImageView; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      resolve(xhr.status >= 200 && xhr.status < 300 && body.image ? { image: body.image } : { error: body.error && body.error !== "internal" ? body.error : msgs.failed });
    };
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

export function ImageManager({ listingId, initialImages }: { listingId: string; initialImages: ListingImageView[] }) {
  const t = useTranslations("listings.images");
  const [images, setImages] = useState(initialImages);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const busy = uploads.some((u) => !u.error);

  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      setMessage(null);
      const files = Array.from(list);
      let room = MAX_IMAGES - images.length;
      const queue: { key: string; file: File }[] = [];
      const rejects: Upload[] = [];
      for (const file of files) {
        const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
        // Client pre-check for fast feedback only; the server re-validates by magic bytes.
        const err = !TYPES.includes(file.type) ? t("badType") : file.size > MAX_BYTES ? t("tooBig") : room <= 0 ? t("maxPer", { max: MAX_IMAGES }) : undefined;
        if (err) rejects.push({ key, name: file.name, progress: 0, error: err });
        else {
          room--;
          queue.push({ key, file });
        }
      }
      setUploads((u) => [...u, ...rejects, ...queue.map((q) => ({ key: q.key, name: q.file.name, progress: 0 }))]);
      for (const { key, file } of queue) {
        const r = await uploadOne(listingId, file, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x))), { network: t("network"), failed: t("uploadFailed") });
        if (r.image) {
          const img = r.image;
          setImages((cur) => [...cur, img]);
          setUploads((u) => u.filter((x) => x.key !== key));
        } else setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: r.error } : x)));
      }
    },
    [images.length, listingId, t],
  );

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    const next = [...images];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setImages(next);
    startTransition(async () => {
      const r = await reorderImagesAction(listingId, next.map((x) => x.id));
      if (!r.ok) {
        setMessage(r.error);
        setImages(images);
      }
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const r = await deleteImageAction(id);
      if (r.ok) setImages((cur) => cur.filter((x) => x.id !== id));
      else setMessage(r.error);
    });
  }

  function saveAlt(id: string, alt: string) {
    const cur = images.find((x) => x.id === id);
    if (!cur || (cur.altText ?? "") === alt.trim()) return;
    startTransition(async () => {
      const r = await setAltTextAction(id, alt);
      if (r.ok) {
        setImages((all) => all.map((x) => (x.id === id ? r.data : x)));
        if (cur.status === "approved") setMessage(t("altChanged"));
      } else setMessage(r.error);
    });
  }

  return (
    <section aria-labelledby="images-heading" className="space-y-3">
      <div>
        <h2 id="images-heading" className="text-base font-semibold text-ink">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">
          {t("intro", { max: MAX_IMAGES })}
        </p>
      </div>

      {message ? <Alert tone="info">{message}</Alert> : null}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); }}
        className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center ${dragging ? "border-brand-600 bg-brand-50" : "border-line bg-surface"}`}
      >
        <ImagePlus className="size-6 text-muted" aria-hidden />
        <p className="text-sm text-muted">{t("drag")}</p>
        <Button variant="outline-brand" className="min-h-11" onClick={() => input.current?.click()} disabled={images.length >= MAX_IMAGES}>
          {t("choose")}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="sr-only"
          aria-label={t("chooseAria")}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploads.length ? (
        <ul className="space-y-2" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-lg border border-line bg-surface p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink">{u.name}</span>
                {u.error ? (
                  <button type="button" className="min-h-11 px-2 text-brand-700 underline" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>{t("dismiss")}</button>
                ) : (
                  <span className="text-muted">{u.progress}%</span>
                )}
              </div>
              {u.error ? <p className="mt-1 text-danger">{u.error}</p> : <progress className="mt-2 h-1.5 w-full" value={u.progress} max={100} aria-label={t("uploadingAria", { name: u.name })} />}
            </li>
          ))}
        </ul>
      ) : null}

      {images.length ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {images.map((img, i) => {
            const st = STATUS[img.status];
            return (
              <li key={img.id}>
                <Card>
                  <CardBody className="space-y-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- session-gated own-image route, not optimisable */}
                    <img src={img.url} alt={img.altText ?? t("photoAlt", { n: i + 1 })} className="aspect-square w-full rounded-lg bg-canvas object-contain" loading="lazy" />
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone={st.tone}>{t(`status.${img.status}`)}</Badge>
                      {i === 0 ? <span className="text-xs text-muted">{t("main")}</span> : null}
                    </div>
                    {img.status === "rejected" && img.moderationNote ? <p className="text-sm text-danger">{t("reason", { note: img.moderationNote })}</p> : null}
                    <Input
                      defaultValue={img.altText ?? ""}
                      maxLength={200}
                      placeholder={t("altPlaceholder")}
                      aria-label={t("altAria", { n: i + 1 })}
                      className="h-11"
                      onBlur={(e) => saveAlt(img.id, e.currentTarget.value)}
                    />
                    <div className="flex items-center gap-1">
                      <Button variant="outline" className="min-h-11 min-w-11" aria-label={t("earlier", { n: i + 1 })} disabled={i === 0} onClick={() => move(i, -1)}><ArrowLeft className="size-4" aria-hidden /></Button>
                      <Button variant="outline" className="min-h-11 min-w-11" aria-label={t("later", { n: i + 1 })} disabled={i === images.length - 1} onClick={() => move(i, 1)}><ArrowRight className="size-4" aria-hidden /></Button>
                      <Button variant="ghost" className="ml-auto min-h-11 text-danger" onClick={() => remove(img.id)} icon={<Trash2 className="size-4" aria-hidden />}>{t("delete")}</Button>
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : busy ? null : (
        <p className="text-sm text-muted">{t("none")}</p>
      )}
    </section>
  );
}
