"use client";
// Share disclosure: Web Share API when the browser has it, plus WhatsApp, e-mail and copy-link fallbacks.
// Disclosure pattern (button + aria-expanded), not role=menu: every item is an ordinary link or button in tab order.
import { Check, Copy, Mail, MessageCircle, Share2, Smartphone } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

export function whatsappHref(text: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
}
export function mailHref(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const item = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-ink hover:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600";
const noop = () => () => undefined;

export function ShareMenu({ url, title }: { url: string; title: string }) {
  const t = useTranslations("pdp");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // false on the server and during hydration, so the markup matches; then true where the Web Share API exists.
  const canShare = useSyncExternalStore(noop, () => typeof navigator !== "undefined" && typeof navigator.share === "function", () => false);
  const text = t("shareText", { title });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(""), 4000);
    return () => window.clearTimeout(id);
  }, [status]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls="pdp-share-panel"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <Share2 className="size-4" aria-hidden />
        {t("share")}
      </button>
      {open ? (
        <div id="pdp-share-panel" role="group" aria-label={t("shareMenu")} className="absolute left-0 top-full z-30 mt-2 w-64 rounded-card border border-line bg-surface p-1.5 shadow-lg">
          {canShare ? (
            <button
              type="button"
              className={item}
              onClick={() => {
                navigator.share({ title, text, url }).catch(() => undefined); // AbortError when the user cancels
                setOpen(false);
              }}
            >
              <Smartphone className="size-4 text-muted" aria-hidden />
              {t("shareDevice")}
            </button>
          ) : null}
          <a className={item} href={whatsappHref(text, url)} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
            <MessageCircle className="size-4 text-muted" aria-hidden />
            {t("shareWhatsApp")}
          </a>
          <a className={item} href={mailHref(title, `${text}\n${url}`)} onClick={() => setOpen(false)}>
            <Mail className="size-4 text-muted" aria-hidden />
            {t("shareEmail")}
          </a>
          <button
            type="button"
            className={item}
            onClick={async () => {
              const ok = await copyText(url);
              setStatus(ok ? t("copied") : t("copyFailed"));
              if (ok) setOpen(false);
              if (ok) trigger.current?.focus();
            }}
          >
            {status === t("copied") ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4 text-muted" aria-hidden />}
            {t("copyLink")}
          </button>
        </div>
      ) : null}
      {/* Always mounted so the announcement is reliable; visible too, not just spoken. */}
      <p role="status" aria-live="polite" className={status ? "absolute left-0 top-full mt-2 whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-xs text-white" : "sr-only"} data-testid="share-status">
        {status}
      </p>
    </div>
  );
}
