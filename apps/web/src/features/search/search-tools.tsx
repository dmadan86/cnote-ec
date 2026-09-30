"use client";
// Voice + photo search controls for the buyer search bar (ADR-004). Progressive enhancement: rendered `hidden` on the
// server and revealed only when the browser can do it, so the plain GET form keeps working without JS.
// WCAG 2.2 AA: real <button>s with names, >=44px targets, visible focus, aria-pressed for the recording toggle, status in a
// polite live region, no information by colour alone, and nothing time-limited except the 15 s recording cap (announced).
import { Camera, Mic, Square } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import { TurnstileWidget } from "@cnote/next-kit/client";
import { Button, cn } from "@cnote/ui";
import { localizePath, type Locale } from "@/i18n/config";
import { fitWithin, HOLD_MS, isHold, langHint, MAX_VOICE_MS, photoSearchHref, pickRecorderMime } from "./voice-photo";

const CONSENT_KEY = "cnote_voice_consent_v1";
const noop = () => () => undefined;
/** "vp" voice+photo, "p" photo only, "" nothing (server render / no JS). Stable string so useSyncExternalStore does not loop. */
function capabilities(): string {
  const voice = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  return `${voice ? "v" : ""}${typeof fetch === "function" ? "p" : ""}`;
}

const readConsent = () => {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false; // storage blocked: ask every time
  }
};
const writeConsent = () => {
  try {
    window.localStorage.setItem(CONSENT_KEY, "1");
  } catch {
    /* ask again next time */
  }
};

type Voice = "idle" | "consent" | "listening" | "transcribing";
const iconBtn =
  "inline-flex size-11 shrink-0 select-none items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 aria-pressed:border-brand-600 aria-pressed:bg-brand-50";

export function SearchTools({ inputId }: { inputId: string }) {
  const t = useTranslations("search");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const caps = useSyncExternalStore(noop, capabilities, () => "");
  const [voice, setVoice] = useState<Voice>("idle");
  const [photoOpen, setPhotoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pointer = useRef<{ downAt: number; suppressClick: boolean }>({ downAt: 0, suppressClick: false });
  const panel = useRef<HTMLDivElement>(null);

  const hasVoice = caps.includes("v");
  const hasPhoto = caps.includes("p");

  function fillQuery(text: string) {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;
    input.value = text;
    input.focus();
  }

  async function upload(blob: Blob) {
    setVoice("transcribing");
    setStatus(t("voiceTranscribing"));
    try {
      const fd = new FormData();
      fd.set("audio", blob, "query");
      fd.set("lang", langHint(locale));
      fd.set("consent", "1");
      const res = await fetch("/api/search/voice", { method: "POST", body: fd });
      if (res.status === 429) return setStatus(t("voiceLimited"));
      if (!res.ok) return setStatus(t("voiceError"));
      const { text } = (await res.json()) as { text: string };
      if (!text) return setStatus(t("voiceEmpty"));
      fillQuery(text);
      setStatus(t("voiceHeard", { text }));
    } catch {
      setStatus(t("voiceError"));
    } finally {
      setVoice("idle");
    }
  }

  async function start() {
    setStatus("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoice("idle");
      return setStatus(t("voiceDenied"));
    }
    const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop()); // release the microphone immediately
      const blob = new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" });
      chunks.length = 0;
      if (blob.size) void upload(blob);
      else {
        setVoice("idle");
        setStatus(t("voiceEmpty"));
      }
    };
    const timer = setTimeout(() => stop(), MAX_VOICE_MS);
    rec.current = { mr, stream, timer };
    mr.start();
    setVoice("listening");
    setStatus(t("voiceListening"));
  }

  function stop() {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    clearTimeout(r.timer);
    if (r.mr.state !== "inactive") r.mr.stop();
  }

  function press() {
    if (voice === "listening") return stop();
    if (voice !== "idle") return;
    if (!readConsent()) {
      setVoice("consent");
      return setStatus("");
    }
    void start();
  }

  async function shrink(file: File): Promise<Blob> {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const { width, height } = fitWithin(bmp.width, bmp.height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, width, height);
      bmp.close();
      // re-encoding through a canvas also drops EXIF/GPS before the photo leaves the device
      return (await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85))) ?? file;
    } catch {
      return file;
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file || busy) return;
    const token = panel.current?.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value ?? "";
    if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && !token) return setStatus(t("photoHuman"));
    setBusy(true);
    setStatus(t("photoWorking"));
    try {
      const fd = new FormData();
      fd.set("image", await shrink(file), "photo.jpg");
      fd.set("lang", langHint(locale));
      if (token) fd.set("cf-turnstile-response", token);
      const res = await fetch("/api/search/image", { method: "POST", body: fd });
      if (res.status === 429) return setStatus(t("photoLimited"));
      if (res.status === 403) return setStatus(t("photoHuman"));
      if (!res.ok) return setStatus(res.status === 400 || res.status === 413 ? t("photoError") : t("photoFailed"));
      const r = (await res.json()) as { query: string; category: string | null };
      if (!r.query) return setStatus(t("photoUnknown"));
      setStatus(t("photoRedirecting", { q: r.query }));
      router.push(localizePath(photoSearchHref(r), locale));
    } catch {
      setStatus(t("photoFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div hidden={!hasVoice && !hasPhoto} className="flex gap-2" role="group" aria-label={t("toolsAria")}>
        {hasVoice ? (
          <button
            type="button"
            className={cn(iconBtn, "touch-none")}
            aria-pressed={voice === "listening"}
            aria-label={t("voiceAria")}
            aria-describedby="search-tools-hint"
            disabled={voice === "transcribing"}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={() => {
              pointer.current = { downAt: Date.now(), suppressClick: voice === "idle" && readConsent() };
              if (voice === "idle" && readConsent()) void start();
            }}
            onPointerUp={() => {
              if (voice === "listening" && pointer.current.suppressClick && isHold(pointer.current.downAt, Date.now())) stop();
            }}
            onPointerCancel={() => voice === "listening" && stop()}
            onClick={() => {
              if (pointer.current.suppressClick) {
                pointer.current.suppressClick = false; // this click is the tail of the press that already started recording
                return;
              }
              press();
            }}
          >
            {voice === "listening" ? <Square className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
          </button>
        ) : null}
        {hasPhoto ? (
          <button type="button" className={iconBtn} aria-expanded={photoOpen} aria-controls="search-photo-panel" aria-label={t("photoAria")} onClick={() => setPhotoOpen((v) => !v)}>
            <Camera className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="basis-full">
        <p id="search-tools-hint" className="sr-only">{t("voiceHint", { seconds: MAX_VOICE_MS / 1000, hold: HOLD_MS / 1000 })}</p>
        {voice === "consent" ? (
          <div role="group" aria-labelledby="voice-consent-title" className="mt-2 rounded-lg border border-line bg-surface p-3 text-sm text-ink">
            <p id="voice-consent-title" className="font-semibold">{t("voiceNoticeTitle")}</p>
            <p className="mt-1 text-muted">{t("voiceNotice")}</p>
            <div className="mt-3 flex gap-2">
              <Button
                size="md"
                onClick={() => {
                  writeConsent();
                  void start();
                }}
              >
                {t("voiceAgree")}
              </Button>
              <Button size="md" variant="outline" onClick={() => setVoice("idle")}>{t("cancel")}</Button>
            </div>
          </div>
        ) : null}
        {photoOpen && hasPhoto ? (
          <div id="search-photo-panel" ref={panel} role="group" aria-labelledby="photo-title" className="mt-2 rounded-lg border border-line bg-surface p-3 text-sm text-ink">
            <p id="photo-title" className="font-semibold">{t("photoTitle")}</p>
            <p className="mt-1 text-muted">{t("photoNotice")}</p>
            <TurnstileWidget className="mt-3" />
            <label className="mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-brand-600 px-4 font-semibold text-brand-700 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600 hover:bg-brand-50">
              <Camera className="size-4" aria-hidden />
              {t("photoChoose")}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} onChange={(e) => void onPhoto(e.target.files?.[0])} />
            </label>
          </div>
        ) : null}
        <p role="status" aria-live="polite" className={cn("text-sm text-muted", status && "mt-2")}>{status}</p>
      </div>
    </>
  );
}
