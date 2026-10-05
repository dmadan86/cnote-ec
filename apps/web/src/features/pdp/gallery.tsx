"use client";
// Product image gallery: main image + thumbnails, and an accessible full-screen viewer built on a native modal <dialog>
// (focus is trapped and restored by the browser, Esc closes). Arrow keys change the image; zoom is a CSS transform driven
// by buttons, +/- keys, pinch and drag. Blur-up comes from ProductImage / BlurImage. No video: listings do not model one.
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import { ProductImage } from "@/features/search/product-image";
import { useVariantSelection } from "./variant-context";
import { clampPan, clampScale, nextIndex, pinchScale, ZOOM_MAX, ZOOM_STEP } from "./zoom";

export interface GalleryImage {
  /** ListingImage id (LIVE views), so a chosen variant can bring its own image to the front */
  id?: string | null;
  src: string;
  blur: string | null;
  alt: string;
}

const iconBtn =
  "inline-flex size-11 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-40";

export function Gallery({ images, title }: { images: GalleryImage[]; title: string }) {
  const t = useTranslations("pdp");
  const [active, setActive] = useState(0);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const total = images.length;
  const current = images[active];
  const variantImageId = useVariantSelection().selected?.imageId ?? null;
  // a newly chosen variant brings its own image to the front (state adjusted during render, not in an effect)
  const [shownVariantImage, setShownVariantImage] = useState<string | null>(null);
  if (variantImageId !== shownVariantImage) {
    setShownVariantImage(variantImageId);
    const i = variantImageId ? images.findIndex((x) => x.id === variantImageId) : -1;
    if (i >= 0) setActive(i);
  }

  const open = (i: number) => {
    setLightbox(i);
  };
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (lightbox !== null && !d.open) {
      d.showModal();
      document.documentElement.style.overflow = "hidden";
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus(); // the close button, not the first (possibly disabled) zoom control
    }
    if (lightbox === null && d.open) d.close();
  }, [lightbox]);
  useEffect(() => () => void document.documentElement.style.removeProperty("overflow"), []);

  if (!total || !current) {
    return (
      <div className="relative aspect-square overflow-hidden rounded-card border border-line bg-surface">
        <ProductImage src={undefined} sizes="45vw" alt={title} />
      </div>
    );
  }

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-card border border-line bg-surface">
        <ProductImage src={current.src} blur={current.blur} sizes="(min-width: 1024px) 45vw, 100vw" priority={active === 0} preload={active === 0} alt={current.alt} />
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={t("openImage", { n: active + 1, total })}
          onClick={() => open(active)}
          className="group absolute inset-0 cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand-600"
        >
          <span aria-hidden className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white">
            <Maximize2 className="size-3.5" />
            {active + 1} / {total}
          </span>
        </button>
      </div>
      {total > 1 ? (
        <ul className="mt-3 grid grid-cols-5 gap-2" aria-label={t("galleryRegion")}>
          {images.map((im, i) => (
            <li key={`${i}-${im.src}`} className="relative aspect-square">
              <div className={`relative size-full overflow-hidden rounded-lg border bg-surface ${i === active ? "border-2 border-brand-600" : "border-line"}`}>
                <ProductImage src={im.src} blur={im.blur} sizes="12vw" alt="" />
              </div>
              <button
                type="button"
                aria-label={t("showImage", { n: i + 1 })}
                aria-current={i === active ? "true" : undefined}
                onClick={() => setActive(i)}
                className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <dialog
        ref={dialogRef}
        aria-label={t("lightbox", { title })}
        onClose={() => {
          if (lightbox !== null) setActive(lightbox);
          setLightbox(null);
          document.documentElement.style.removeProperty("overflow");
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialogRef.current?.close(); // backdrop
        }}
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-black p-0 text-white open:flex open:flex-col backdrop:bg-black"
      >
        {lightbox !== null ? <Viewer images={images} index={lightbox} onIndex={setLightbox} onClose={() => dialogRef.current?.close()} /> : null}
      </dialog>
    </div>
  );
}

function Viewer({ images, index, onIndex, onClose }: { images: GalleryImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const t = useTranslations("pdp");
  const total = images.length;
  const im = images[index]!;
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const size = () => {
    const r = stage.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  };
  const zoomTo = useCallback((scale: number) => {
    setView((v) => {
      const s = clampScale(scale);
      const r = stage.current?.getBoundingClientRect();
      return s === 1 ? { scale: 1, x: 0, y: 0 } : { scale: s, ...clampPan(v.x, v.y, s, r?.width ?? 0, r?.height ?? 0) };
    });
  }, []);
  const go = (delta: number) => {
    setView({ scale: 1, x: 0, y: 0 });
    onIndex(nextIndex(index, delta, total));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight") go(k === "ArrowRight" ? 1 : -1);
    else if (k === "Home") onIndex(0);
    else if (k === "End") onIndex(total - 1);
    else if (k === "+" || k === "=") zoomTo(view.scale + ZOOM_STEP);
    else if (k === "-" || k === "_") zoomTo(view.scale - ZOOM_STEP);
    else if (k === "0") zoomTo(1);
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), scale: view.scale };
    }
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      zoomTo(pinchScale(pinch.current.scale, pinch.current.dist, Math.hypot(a!.x - b!.x, a!.y - b!.y)));
    } else if (view.scale > 1) {
      const { w, h } = size();
      setView((v) => ({ ...v, ...clampPan(v.x + cur.x - prev.x, v.y + cur.y - prev.y, v.scale, w, h) }));
    }
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) setDragging(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between gap-3 p-3">
        <p className="text-sm font-medium" aria-live="polite" aria-atomic="true">
          {t("counter", { n: index + 1, total })}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" className={iconBtn} aria-label={t("zoomOut")} disabled={view.scale <= 1} onClick={() => zoomTo(view.scale - ZOOM_STEP)}>
            <Minus className="size-5" aria-hidden />
          </button>
          <span className="min-w-12 text-center text-sm tabular-nums" role="status" aria-label={t("zoomLevel", { pct: Math.round(view.scale * 100) })}>
            {Math.round(view.scale * 100)}%
          </span>
          <button type="button" className={iconBtn} aria-label={t("zoomIn")} disabled={view.scale >= ZOOM_MAX} onClick={() => zoomTo(view.scale + ZOOM_STEP)}>
            <Plus className="size-5" aria-hidden />
          </button>
          <button type="button" className={iconBtn} aria-label={t("zoomReset")} disabled={view.scale === 1} onClick={() => zoomTo(1)}>
            <RotateCcw className="size-5" aria-hidden />
          </button>
          <button type="button" data-autofocus="" className={iconBtn} aria-label={t("close")} onClick={onClose}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={stage}
          className="absolute inset-0 touch-none overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          style={{ cursor: view.scale > 1 ? (dragging ? "grabbing" : "grab") : "default" }}
        >
          <div
            className={`relative size-full ${dragging ? "" : "transition-transform duration-150 motion-reduce:transition-none"}`}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            data-testid="lightbox-zoom"
            data-scale={view.scale}
          >
            <ProductImage key={im.src} src={im.src} blur={im.blur} sizes="100vw" alt={im.alt} priority />
          </div>
        </div>
        {total > 1 ? (
          <>
            <button type="button" className={`${iconBtn} absolute left-3 top-1/2 -translate-y-1/2`} aria-label={t("prev")} onClick={() => go(-1)}>
              <ChevronLeft className="size-6" aria-hidden />
            </button>
            <button type="button" className={`${iconBtn} absolute right-3 top-1/2 -translate-y-1/2`} aria-label={t("next")} onClick={() => go(1)}>
              <ChevronRight className="size-6" aria-hidden />
            </button>
          </>
        ) : null}
      </div>
      <p className="p-3 text-center text-xs text-white/80">{t("zoomHint")}</p>
    </div>
  );
}
