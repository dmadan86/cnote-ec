"use client";
import { SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, type ReactNode } from "react";
import { buttonClasses } from "@cnote/ui";

/**
 * Mobile filters: a "Filters" button that opens the filter form in a native modal <dialog> (showModal gives the focus trap,
 * inert background, Esc to close and focus return to this button for free). The form inside is a plain GET form, so applying
 * it navigates and the new page replaces the sheet. Hidden from lg up, where the same form is a sidebar.
 */
export function FiltersSheet({ count, children }: { count: number; children: ReactNode }) {
  const t = useTranslations("filters");
  const ref = useRef<HTMLDialogElement>(null);
  const root = () => document.documentElement;

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          ref.current?.showModal();
          root().classList.add("overflow-hidden");
        }}
        className={buttonClasses("outline", "md", "min-h-11")}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {count > 0 ? t("openCount", { count }) : t("open")}
      </button>
      <dialog
        ref={ref}
        aria-labelledby="filters-sheet-title"
        onClose={() => root().classList.remove("overflow-hidden")}
        className="m-auto max-h-[92dvh] w-[calc(100vw-1rem)] max-w-md flex-col overflow-hidden rounded-card border border-line bg-surface p-0 text-ink shadow-xl open:flex backdrop:bg-black/50"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id="filters-sheet-title" className="text-base font-semibold">
            {t("sheetTitle")}
          </h2>
          <button type="button" onClick={() => ref.current?.close()} aria-label={t("close")} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </dialog>
    </div>
  );
}
