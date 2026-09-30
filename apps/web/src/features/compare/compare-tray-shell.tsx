"use client";
import { ChevronDown, ChevronUp, Scale } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

/** Sticky bottom tray chrome. The content (thumbnails, forms) is server-rendered and passed as children. */
export function CompareTrayShell({ count, children }: { count: number; children: ReactNode }) {
  const t = useTranslations("compare");
  const [open, setOpen] = useState(true);
  return (
    <section aria-label={t("trayLabel")} className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface shadow-[0_-4px_16px_rgba(17,24,39,0.08)]">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-2 px-4 py-1.5 sm:px-6 lg:px-8">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Scale className="size-4 text-brand-600" aria-hidden /> {t("trayCount", { count, max: 4 })}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="compare-tray-body"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
          {open ? t("hide") : t("show")}
        </button>
      </div>
      <div id="compare-tray-body" hidden={!open} className="mx-auto max-w-[1280px] px-4 pb-3 sm:px-6 lg:px-8">
        {children}
      </div>
    </section>
  );
}
